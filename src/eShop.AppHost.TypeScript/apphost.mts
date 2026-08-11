import {
  createBuilder,
  QueryParameterMatchMode,
  type ProjectResource,
  type YarpCluster,
  type YarpConfigurationBuilder,
} from './.aspire/modules/aspire.mjs';

const builder = await createBuilder();
await builder.addAzureContainerAppEnvironment('aca');

const launchProfileName = process.env.ESHOP_USE_HTTP_ENDPOINTS === '1' ? 'http' : 'https';
const projectPath = (name: string) => `../${name}/${name}.csproj`;

const addProject = (name: string, path: string, launchProfile?: string) =>
  builder.addProject(name, path, { launchProfileOrOptions: launchProfile })
    .withEnvironment('ASPNETCORE_FORWARDEDHEADERS_ENABLED', 'true');

const withProjectEndpoints = async (
  resource: ProjectResource | PromiseLike<ProjectResource>,
  hasHttps = false,
) => {
  let configured = await resource;
  configured = await configured.withHttpEndpointCallback(
    endpoint => endpoint.port.set(null),
    { name: 'http' },
  );
  if (launchProfileName === 'https' && hasHttps) {
    configured = await configured.withHttpsEndpointCallback(
      endpoint => endpoint.port.set(null),
      { name: 'https' },
    );
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
  true,
);

const identityEndpoint = identityApi.getEndpoint(launchProfileName);

const basketApi = await withProjectEndpoints(
  addProject('basket-api', projectPath('Basket.API'))
    .withReference(redis)
    .withReference(rabbitMq).waitFor(rabbitMq)
    .withEnvironment('Identity__Url', identityEndpoint),
);

const catalogApi = await withProjectEndpoints(
  addProject('catalog-api', projectPath('Catalog.API'))
    .withReference(rabbitMq).waitFor(rabbitMq)
    .withReference(catalogDb),
);

const orderingApi = await withProjectEndpoints(
  addProject('ordering-api', projectPath('Ordering.API'))
    .withReference(rabbitMq).waitFor(rabbitMq)
    .withReference(orderDb).waitFor(orderDb)
    .withHttpHealthCheck({ path: '/health' })
    .withEnvironment('Identity__Url', identityEndpoint),
);

await withProjectEndpoints(
  addProject('order-processor', projectPath('OrderProcessor'))
    .withReference(rabbitMq).waitFor(rabbitMq)
    .withReference(orderDb)
    .waitFor(orderingApi),
);

await withProjectEndpoints(
  addProject('payment-processor', projectPath('PaymentProcessor'))
    .withReference(rabbitMq).waitFor(rabbitMq),
);

const webHooksApi = await withProjectEndpoints(
  addProject('webhooks-api', projectPath('Webhooks.API'))
    .withReference(rabbitMq).waitFor(rabbitMq)
    .withReference(webhooksDb)
    .withEnvironment('Identity__Url', identityEndpoint),
);

await builder.addYarp('mobile-bff')
  .withExternalHttpEndpoints()
  .withConfiguration(configureMobileBffRoutes);

const webhooksClient = await withProjectEndpoints(
  addProject('webhooksclient', projectPath('WebhookClient'), launchProfileName)
    .withReference(webHooksApi)
    .withEnvironment('IdentityUrl', identityEndpoint),
  true,
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
  true,
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