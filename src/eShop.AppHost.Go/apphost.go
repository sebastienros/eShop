package main

import (
	"apphost/modules/aspire"
	"log"
	"os"
)

func main() {
	builder, err := aspire.CreateBuilder()
	if err != nil {
		log.Fatal(aspire.FormatError(err))
	}

	launchProfileName := "https"
	if os.Getenv("ESHOP_USE_HTTP_ENDPOINTS") == "1" {
		launchProfileName = "http"
	}

	redis := builder.AddRedis("redis")
	rabbitMq := builder.AddRabbitMQ("eventbus").WithPersistentLifetime()
	postgres := builder.AddPostgres("postgres").
		WithImage("ankane/pgvector").
		WithImageTag("latest").
		WithPersistentLifetime()

	catalogDb := postgres.AddDatabase("catalogdb")
	identityDb := postgres.AddDatabase("identitydb")
	orderDb := postgres.AddDatabase("orderingdb")
	webhooksDb := postgres.AddDatabase("webhooksdb")

	identityApi := addProject(builder, "identity-api", projectPath("Identity.API"), launchProfileName).
		WithExternalHttpEndpoints().
		WithReference(identityDb).
		WithHttpHealthCheck(&aspire.WithHttpHealthCheckOptions{Path: strPtr("/health")})

	identityEndpoint := identityApi.GetEndpoint(launchProfileName)

	basketApi := addProject(builder, "basket-api", projectPath("Basket.API"), "").
		WithReference(redis).
		WithReference(rabbitMq).WaitFor(rabbitMq).
		WithEnvironment("Identity__Url", identityEndpoint)

	catalogApi := addProject(builder, "catalog-api", projectPath("Catalog.API"), "").
		WithReference(rabbitMq).WaitFor(rabbitMq).
		WithReference(catalogDb)

	orderingApi := addProject(builder, "ordering-api", projectPath("Ordering.API"), "").
		WithReference(rabbitMq).WaitFor(rabbitMq).
		WithReference(orderDb).WaitFor(orderDb).
		WithHttpHealthCheck(&aspire.WithHttpHealthCheckOptions{Path: strPtr("/health")}).
		WithEnvironment("Identity__Url", identityEndpoint)

	addProject(builder, "order-processor", projectPath("OrderProcessor"), "").
		WithReference(rabbitMq).WaitFor(rabbitMq).
		WithReference(orderDb).
		WaitFor(orderingApi)

	addProject(builder, "payment-processor", projectPath("PaymentProcessor"), "").
		WithReference(rabbitMq).WaitFor(rabbitMq)

	webhooksApi := addProject(builder, "webhooks-api", projectPath("Webhooks.API"), "").
		WithReference(rabbitMq).WaitFor(rabbitMq).
		WithReference(webhooksDb).
		WithEnvironment("Identity__Url", identityEndpoint)

	builder.AddYarp("mobile-bff").
		WithExternalHttpEndpoints().
		WithConfiguration(func(yarp aspire.YarpConfigurationBuilder) {
			configureMobileBffRoutes(yarp, catalogApi, orderingApi, identityApi)
		})

	webhooksClient := addProject(builder, "webhooksclient", projectPath("WebhookClient"), launchProfileName).
		WithReference(webhooksApi).
		WithEnvironment("IdentityUrl", identityEndpoint)

	webApp := addProject(builder, "webapp", projectPath("WebApp"), launchProfileName).
		WithExternalHttpEndpoints().
		WithReference(basketApi).
		WithReference(catalogApi).
		WithReference(orderingApi).
		WithReference(rabbitMq).WaitFor(rabbitMq).
		WaitFor(identityApi).
		WithEnvironment("IdentityUrl", identityEndpoint)

	webApp.WithEnvironment("CallBackUrl", webApp.GetEndpoint(launchProfileName))
	webhooksClient.WithEnvironment("CallBackUrl", webhooksClient.GetEndpoint(launchProfileName))

	identityApi.
		WithEnvironment("BasketApiClient", basketApi.GetEndpoint("http")).
		WithEnvironment("OrderingApiClient", orderingApi.GetEndpoint("http")).
		WithEnvironment("WebhooksApiClient", webhooksApi.GetEndpoint("http")).
		WithEnvironment("WebhooksWebClient", webhooksClient.GetEndpoint(launchProfileName)).
		WithEnvironment("WebAppClient", webApp.GetEndpoint(launchProfileName))

	if err := builder.Err(); err != nil {
		log.Fatal(aspire.FormatError(err))
	}

	app, err := builder.Build()
	if err != nil {
		log.Fatal(aspire.FormatError(err))
	}
	if err := app.Run(); err != nil {
		log.Fatal(aspire.FormatError(err))
	}
}

func addProject(builder aspire.DistributedApplicationBuilder, name, path, launchProfile string) aspire.ProjectResource {
	var options []*aspire.AddProjectOptions
	if launchProfile != "" {
		options = append(options, &aspire.AddProjectOptions{LaunchProfileOrOptions: launchProfile})
	}
	return builder.AddProject(name, path, options...).
		WithEnvironment("ASPNETCORE_FORWARDEDHEADERS_ENABLED", "true")
}

func projectPath(name string) string {
	return "../" + name + "/" + name + ".csproj"
}

func configureMobileBffRoutes(yarp aspire.YarpConfigurationBuilder, catalogApi, orderingApi, identityApi aspire.ProjectResource) {
	catalogCluster := yarp.AddClusterFromResource(catalogApi)
	catalogRoute(yarp, catalogCluster, "/catalog-api/api/catalog/items", "1.0", "1", "2.0")
	catalogRoute(yarp, catalogCluster, "/catalog-api/api/catalog/items/by", "1.0", "1", "2.0")
	catalogRoute(yarp, catalogCluster, "/catalog-api/api/catalog/items/{id}", "1.0", "1", "2.0")
	catalogRoute(yarp, catalogCluster, "/catalog-api/api/catalog/items/by/{name}", "1.0", "1")
	catalogRoute(yarp, catalogCluster, "/catalog-api/api/catalog/items/withsemanticrelevance/{text}", "1.0", "1")
	catalogRoute(yarp, catalogCluster, "/catalog-api/api/catalog/items/withsemanticrelevance", "2.0")
	catalogRoute(yarp, catalogCluster, "/catalog-api/api/catalog/items/type/{typeId}/brand/{brandId?}", "1.0", "1")
	catalogRoute(yarp, catalogCluster, "/catalog-api/api/catalog/items/type/all/brand/{brandId?}", "1.0", "1")
	catalogRoute(yarp, catalogCluster, "/catalog-api/api/catalog/catalogTypes", "1.0", "1", "2.0")
	catalogRoute(yarp, catalogCluster, "/catalog-api/api/catalog/catalogBrands", "1.0", "1", "2.0")
	catalogRoute(yarp, catalogCluster, "/catalog-api/api/catalog/items/{id}/pic", "1.0", "1", "2.0")

	yarp.AddRoute("/api/catalog/{*any}", catalogCluster).
		WithMatchRouteQueryParameter([]*aspire.YarpRouteQueryParameterMatch{apiVersion("1.0", "1", "2.0")})
	yarp.AddRoute("/api/orders/{*any}", orderingApi.GetEndpoint("http")).
		WithMatchRouteQueryParameter([]*aspire.YarpRouteQueryParameterMatch{apiVersion("1.0", "1")})
	yarp.AddRoute("/identity/{*any}", identityApi.GetEndpoint("http")).
		WithTransformPathRemovePrefix("/identity")
}

func catalogRoute(yarp aspire.YarpConfigurationBuilder, catalogCluster aspire.YarpCluster, path string, versions ...string) {
	yarp.AddRoute(path, catalogCluster).
		WithMatchRouteQueryParameter([]*aspire.YarpRouteQueryParameterMatch{apiVersion(versions...)}).
		WithTransformPathRemovePrefix("/catalog-api")
}

func apiVersion(values ...string) *aspire.YarpRouteQueryParameterMatch {
	return &aspire.YarpRouteQueryParameterMatch{
		Name:   "api-version",
		Values: values,
		Mode:   aspire.QueryParameterMatchModeExact,
	}
}

func strPtr(value string) *string {
	return &value
}