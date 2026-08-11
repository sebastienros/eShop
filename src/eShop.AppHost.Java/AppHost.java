import aspire.*;

void main(String[] args) throws Exception {
    var launchProfileName = "1".equals(System.getenv("ESHOP_USE_HTTP_ENDPOINTS")) ? "http" : "https";
    var builder = DistributedApplication.CreateBuilder(args);

    var redis = builder.addRedis("redis");
    var rabbitMq = builder.addRabbitMQ("eventbus").withPersistentLifetime();
    var postgres = builder.addPostgres("postgres")
        .withImage("ankane/pgvector")
        .withImageTag("latest")
        .withPersistentLifetime();

    var catalogDb = postgres.addDatabase("catalogdb");
    var identityDb = postgres.addDatabase("identitydb");
    var orderDb = postgres.addDatabase("orderingdb");
    var webhooksDb = postgres.addDatabase("webhooksdb");

    var identityApi = withProjectEndpoints(
        addProject(builder, "identity-api", projectPath("Identity.API"), launchProfileName)
            .withExternalHttpEndpoints()
            .withReference(identityDb, null)
            .withHttpHealthCheck(new WithHttpHealthCheckOptions().path("/health")),
        launchProfileName,
        true);

    var identityEndpoint = identityApi.getEndpoint(launchProfileName);

    var basketApi = withProjectEndpoints(
        addProject(builder, "basket-api", projectPath("Basket.API"))
            .withReference(redis, null)
            .withReference(rabbitMq, null).waitFor(rabbitMq)
            .withEnvironment("Identity__Url", identityEndpoint),
        launchProfileName);

    var catalogApi = withProjectEndpoints(
        addProject(builder, "catalog-api", projectPath("Catalog.API"))
            .withReference(rabbitMq, null).waitFor(rabbitMq)
            .withReference(catalogDb, null),
        launchProfileName);

    var orderingApi = withProjectEndpoints(
        addProject(builder, "ordering-api", projectPath("Ordering.API"))
            .withReference(rabbitMq, null).waitFor(rabbitMq)
            .withReference(orderDb, null).waitFor(orderDb)
            .withHttpHealthCheck(new WithHttpHealthCheckOptions().path("/health"))
            .withEnvironment("Identity__Url", identityEndpoint),
        launchProfileName);

    withProjectEndpoints(
        addProject(builder, "order-processor", projectPath("OrderProcessor"))
            .withReference(rabbitMq, null).waitFor(rabbitMq)
            .withReference(orderDb, null)
            .waitFor(orderingApi),
        launchProfileName);

    withProjectEndpoints(
        addProject(builder, "payment-processor", projectPath("PaymentProcessor"))
            .withReference(rabbitMq, null).waitFor(rabbitMq),
        launchProfileName);

    var webhooksApi = withProjectEndpoints(
        addProject(builder, "webhooks-api", projectPath("Webhooks.API"))
            .withReference(rabbitMq, null).waitFor(rabbitMq)
            .withReference(webhooksDb, null)
            .withEnvironment("Identity__Url", identityEndpoint),
        launchProfileName);

    builder.addYarp("mobile-bff")
        .withExternalHttpEndpoints()
        .withConfiguration(yarp -> configureMobileBffRoutes(yarp, catalogApi, orderingApi, identityApi));

    var webhooksClient = withProjectEndpoints(
        addProject(builder, "webhooksclient", projectPath("WebhookClient"), launchProfileName)
            .withReference(webhooksApi, null)
            .withEnvironment("IdentityUrl", identityEndpoint),
        launchProfileName,
        true);

    var webApp = withProjectEndpoints(
        addProject(builder, "webapp", projectPath("WebApp"), launchProfileName)
            .withExternalHttpEndpoints()
            .withReference(basketApi, null)
            .withReference(catalogApi, null)
            .withReference(orderingApi, null)
            .withReference(rabbitMq, null).waitFor(rabbitMq)
            .waitFor(identityApi)
            .withEnvironment("IdentityUrl", identityEndpoint),
        launchProfileName,
        true);

    webApp.withEnvironment("CallBackUrl", webApp.getEndpoint(launchProfileName));
    webhooksClient.withEnvironment("CallBackUrl", webhooksClient.getEndpoint(launchProfileName));

    identityApi.withEnvironment("BasketApiClient", basketApi.getEndpoint("http"))
        .withEnvironment("OrderingApiClient", orderingApi.getEndpoint("http"))
        .withEnvironment("WebhooksApiClient", webhooksApi.getEndpoint("http"))
        .withEnvironment("WebhooksWebClient", webhooksClient.getEndpoint(launchProfileName))
        .withEnvironment("WebAppClient", webApp.getEndpoint(launchProfileName));

    builder.build().run();
}

ProjectResource addProject(IDistributedApplicationBuilder builder, String name, String projectPath) {
    return addProject(builder, name, projectPath, null);
}

ProjectResource addProject(IDistributedApplicationBuilder builder, String name, String projectPath, String launchProfile) {
    return builder.addProject(name, projectPath, launchProfile)
        .withEnvironment("ASPNETCORE_FORWARDEDHEADERS_ENABLED", "true");
}

ProjectResource withProjectEndpoints(ProjectResource resource, String launchProfileName) {
    return withProjectEndpoints(resource, launchProfileName, false);
}

ProjectResource withProjectEndpoints(ProjectResource resource, String launchProfileName, boolean hasHttps) {
    // Zero clears the desired host port so DCP allocates one dynamically.
    resource.withHttpEndpointCallback(
        endpoint -> endpoint.setPort(0),
        new WithHttpEndpointCallbackOptions().name("http"));
    if ("https".equals(launchProfileName) && hasHttps) {
        resource.withHttpsEndpointCallback(
            endpoint -> endpoint.setPort(0),
            new WithHttpsEndpointCallbackOptions().name("https"));
    }
    return resource;
}

String projectPath(String name) {
    return "../" + name + "/" + name + ".csproj";
}

void configureMobileBffRoutes(IYarpConfigurationBuilder yarp, ProjectResource catalogApi, ProjectResource orderingApi, ProjectResource identityApi) {
    var catalogCluster = yarp.addClusterFromResource(catalogApi);
    catalogRoute(yarp, catalogCluster, "/catalog-api/api/catalog/items", "1.0", "1", "2.0");
    catalogRoute(yarp, catalogCluster, "/catalog-api/api/catalog/items/by", "1.0", "1", "2.0");
    catalogRoute(yarp, catalogCluster, "/catalog-api/api/catalog/items/{id}", "1.0", "1", "2.0");
    catalogRoute(yarp, catalogCluster, "/catalog-api/api/catalog/items/by/{name}", "1.0", "1");
    catalogRoute(yarp, catalogCluster, "/catalog-api/api/catalog/items/withsemanticrelevance/{text}", "1.0", "1");
    catalogRoute(yarp, catalogCluster, "/catalog-api/api/catalog/items/withsemanticrelevance", "2.0");
    catalogRoute(yarp, catalogCluster, "/catalog-api/api/catalog/items/type/{typeId}/brand/{brandId?}", "1.0", "1");
    catalogRoute(yarp, catalogCluster, "/catalog-api/api/catalog/items/type/all/brand/{brandId?}", "1.0", "1");
    catalogRoute(yarp, catalogCluster, "/catalog-api/api/catalog/catalogTypes", "1.0", "1", "2.0");
    catalogRoute(yarp, catalogCluster, "/catalog-api/api/catalog/catalogBrands", "1.0", "1", "2.0");
    catalogRoute(yarp, catalogCluster, "/catalog-api/api/catalog/items/{id}/pic", "1.0", "1", "2.0");

    yarp.addRoute("/api/catalog/{*any}", catalogCluster)
        .withMatchRouteQueryParameter(new YarpRouteQueryParameterMatch[] { apiVersion("1.0", "1", "2.0") });
    yarp.addRoute("/api/orders/{*any}", orderingApi.getEndpoint("http"))
        .withMatchRouteQueryParameter(new YarpRouteQueryParameterMatch[] { apiVersion("1.0", "1") });
    yarp.addRoute("/identity/{*any}", identityApi.getEndpoint("http"))
        .withTransformPathRemovePrefix("/identity");
}

void catalogRoute(IYarpConfigurationBuilder yarp, YarpCluster catalogCluster, String path, String... versions) {
    yarp.addRoute(path, catalogCluster)
        .withMatchRouteQueryParameter(new YarpRouteQueryParameterMatch[] { apiVersion(versions) })
        .withTransformPathRemovePrefix("/catalog-api");
}

YarpRouteQueryParameterMatch apiVersion(String... versions) {
    var match = new YarpRouteQueryParameterMatch();
    match.setName("api-version");
    match.setValues(versions);
    match.setMode(QueryParameterMatchMode.EXACT);
    return match;
}