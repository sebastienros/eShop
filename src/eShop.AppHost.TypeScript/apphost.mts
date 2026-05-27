import {
  createBuilder,
  QueryParameterMatchMode,
  type ProjectResource,
  type YarpCluster,
  type YarpConfigurationBuilder,
} from './.aspire/modules/aspire.mjs';

const builder = await createBuilder();

const launchProfileName = process.env.ESHOP_USE_HTTP_ENDPOINTS === '1' ? 'http' : 'https';
const projectPath = (name: string) => `../${name}/${name}.csproj`;

type ProjectEndpointPorts = { http: number; https?: number };

const endpointPorts = {
  basketApi: { http: 15221 },
  catalogApi: { http: 15222 },
  identityApi: { http: 15223, https: 15243 },
  orderingApi: { http: 15224 },
  paymentProcessor: { http: 15226 },
  webhooksApi: { http: 15227 },
  webApp: { http: 15045, https: 17298 },
  webhooksClient: { http: 15062, https: 17260 },
  orderProcessor: { http: 26888 },
  mobileBff: { http: 15080 },
} satisfies Record<string, ProjectEndpointPorts>;

const addProject = (name: string, path: string, launchProfile?: string) =>
  builder.addProject(name, path, { launchProfileOrOptions: launchProfile })
    .withEnvironment('ASPNETCORE_FORWARDEDHEADERS_ENABLED', 'true');

const withProjectEndpoints = async (
  resource: ProjectResource | PromiseLike<ProjectResource>,
  ports: ProjectEndpointPorts,
) => {
  let configured = await resource;
  configured = await configured.withHttpEndpoint({ name: 'http', port: ports.http });
  if (launchProfileName === 'https' && ports.https !== undefined) {
    configured = await configured.withHttpsEndpoint({ name: 'https', port: ports.https });
  }
  return configured;
};

const redis = await builder.addRedis('redis');
const rabbitMq = await builder.addRabbitMQ('eventbus').withPersistentLifetime();
const postgres = await builder.addPostgres('postgres')
  .withImage('ankane/pgvector')
  .withImageTag('latest')
  .withPersistentLifetime();

const catalogDb = await postgres.addDatabase('catalogdb');
const identityDb = await postgres.addDatabase('identitydb');
const orderDb = await postgres.addDatabase('orderingdb');
const webhooksDb = await postgres.addDatabase('webhooksdb');

const identityApi = await withProjectEndpoints(
  addProject('identity-api', projectPath('Identity.API'), launchProfileName)
    .withExternalHttpEndpoints()
    .withReference(identityDb)
    .withHttpHealthCheck({ path: '/health' }),
  endpointPorts.identityApi,
);

const identityEndpoint = identityApi.getEndpoint(launchProfileName);

const basketApi = await withProjectEndpoints(
  addProject('basket-api', projectPath('Basket.API'))
    .withReference(redis)
    .withReference(rabbitMq).waitFor(rabbitMq)
    .withEnvironment('Identity__Url', identityEndpoint),
  endpointPorts.basketApi,
);

const catalogApi = await withProjectEndpoints(
  addProject('catalog-api', projectPath('Catalog.API'))
    .withReference(rabbitMq).waitFor(rabbitMq)
    .withReference(catalogDb),
  endpointPorts.catalogApi,
);

const orderingApi = await withProjectEndpoints(
  addProject('ordering-api', projectPath('Ordering.API'))
    .withReference(rabbitMq).waitFor(rabbitMq)
    .withReference(orderDb).waitFor(orderDb)
    .withHttpHealthCheck({ path: '/health' })
    .withEnvironment('Identity__Url', identityEndpoint),
  endpointPorts.orderingApi,
);

await withProjectEndpoints(
  addProject('order-processor', projectPath('OrderProcessor'))
    .withReference(rabbitMq).waitFor(rabbitMq)
    .withReference(orderDb)
    .waitFor(orderingApi),
  endpointPorts.orderProcessor,
);

await withProjectEndpoints(
  addProject('payment-processor', projectPath('PaymentProcessor'))
    .withReference(rabbitMq).waitFor(rabbitMq),
  endpointPorts.paymentProcessor,
);

const webHooksApi = await withProjectEndpoints(
  addProject('webhooks-api', projectPath('Webhooks.API'))
    .withReference(rabbitMq).waitFor(rabbitMq)
    .withReference(webhooksDb)
    .withEnvironment('Identity__Url', identityEndpoint),
  endpointPorts.webhooksApi,
);

await builder.addYarp('mobile-bff')
  .withHostPort({ port: endpointPorts.mobileBff.http })
  .withExternalHttpEndpoints()
  .withConfiguration(configureMobileBffRoutes);

const webhooksClient = await withProjectEndpoints(
  addProject('webhooksclient', projectPath('WebhookClient'), launchProfileName)
    .withReference(webHooksApi)
    .withEnvironment('IdentityUrl', identityEndpoint),
  endpointPorts.webhooksClient,
);

const webApp = await withProjectEndpoints(
  addProject('webapp', projectPath('WebApp'), launchProfileName)
    .withExternalHttpEndpoints()
    .withReference(basketApi)
    .withReference(catalogApi)
    .withReference(orderingApi)
    .withReference(rabbitMq).waitFor(rabbitMq)
    .waitFor(identityApi)
    .withEnvironment('IdentityUrl', identityEndpoint),
  endpointPorts.webApp,
);

await webApp.withEnvironment('CallBackUrl', webApp.getEndpoint(launchProfileName));
await webhooksClient.withEnvironment('CallBackUrl', webhooksClient.getEndpoint(launchProfileName));

await identityApi
  .withEnvironment('BasketApiClient', basketApi.getEndpoint('http'))
  .withEnvironment('OrderingApiClient', orderingApi.getEndpoint('http'))
  .withEnvironment('WebhooksApiClient', webHooksApi.getEndpoint('http'))
  .withEnvironment('WebhooksWebClient', webhooksClient.getEndpoint(launchProfileName))
  .withEnvironment('WebAppClient', webApp.getEndpoint(launchProfileName));

await builder.build().run();

async function configureMobileBffRoutes(yarp: YarpConfigurationBuilder) {
  const catalogCluster = await yarp.addClusterFromResource(catalogApi);
  await catalogRoute(yarp, catalogCluster, '/catalog-api/api/catalog/items', ['1.0', '1', '2.0']);
  await catalogRoute(yarp, catalogCluster, '/catalog-api/api/catalog/items/by', ['1.0', '1', '2.0']);
  await catalogRoute(yarp, catalogCluster, '/catalog-api/api/catalog/items/{id}', ['1.0', '1', '2.0']);
  await catalogRoute(yarp, catalogCluster, '/catalog-api/api/catalog/items/by/{name}', ['1.0', '1']);
  await catalogRoute(yarp, catalogCluster, '/catalog-api/api/catalog/items/withsemanticrelevance/{text}', ['1.0', '1']);
  await catalogRoute(yarp, catalogCluster, '/catalog-api/api/catalog/items/withsemanticrelevance', ['2.0']);
  await catalogRoute(yarp, catalogCluster, '/catalog-api/api/catalog/items/type/{typeId}/brand/{brandId?}', ['1.0', '1']);
  await catalogRoute(yarp, catalogCluster, '/catalog-api/api/catalog/items/type/all/brand/{brandId?}', ['1.0', '1']);
  await catalogRoute(yarp, catalogCluster, '/catalog-api/api/catalog/catalogTypes', ['1.0', '1', '2.0']);
  await catalogRoute(yarp, catalogCluster, '/catalog-api/api/catalog/catalogBrands', ['1.0', '1', '2.0']);
  await catalogRoute(yarp, catalogCluster, '/catalog-api/api/catalog/items/{id}/pic', ['1.0', '1', '2.0']);

  await yarp.addRoute('/api/catalog/{*any}', catalogCluster)
    .withMatchRouteQueryParameter([apiVersion(['1.0', '1', '2.0'])]);
  await yarp.addRoute('/api/orders/{*any}', orderingApi.getEndpoint('http'))
    .withMatchRouteQueryParameter([apiVersion(['1.0', '1'])]);
  await yarp.addRoute('/identity/{*any}', identityApi.getEndpoint('http'))
    .withTransformPathRemovePrefix('/identity');
}

async function catalogRoute(yarp: YarpConfigurationBuilder, cluster: YarpCluster, path: string, versions: string[]) {
  await yarp.addRoute(path, cluster)
    .withMatchRouteQueryParameter([apiVersion(versions)])
    .withTransformPathRemovePrefix('/catalog-api');
}

function apiVersion(values: string[]) {
  return { name: 'api-version', values, mode: QueryParameterMatchMode.Exact };
}