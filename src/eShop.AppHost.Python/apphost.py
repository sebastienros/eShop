from aspire_app import create_builder

LAUNCH_PROFILE_NAME = "http" if __import__("os").environ.get("ESHOP_USE_HTTP_ENDPOINTS") == "1" else "https"

def project_path(name: str) -> str:
    return f"../{name}/{name}.csproj"


def add_project(builder, name: str, path: str, launch_profile: str | None = None):
    return builder.add_project(name, path, launch_profile_or_options=launch_profile).with_env(
        "ASPNETCORE_FORWARDEDHEADERS_ENABLED", "true"
    )


def api_version(values: list[str]):
    return {"Name": "api-version", "Values": values, "Mode": "Exact"}


def catalog_route(yarp, catalog_cluster, path: str, versions: list[str]):
    return (
        yarp.add_route(path, catalog_cluster)
        .with_match_route_query_parameter([api_version(versions)])
        .with_transform_path_remove_prefix("/catalog-api")
    )


def use_dynamic_port(endpoint):
    endpoint.port = None


def with_project_endpoints(resource, has_https: bool = False):
    resource.with_http_endpoint_callback(use_dynamic_port, name="http")
    if LAUNCH_PROFILE_NAME == "https" and has_https:
        resource.with_https_endpoint_callback(use_dynamic_port, name="https")
    return resource


def configure_mobile_bff_routes(yarp):
    catalog_cluster = yarp.add_cluster_from_resource(catalog_api)
    catalog_route(yarp, catalog_cluster, "/catalog-api/api/catalog/items", ["1.0", "1", "2.0"])
    catalog_route(yarp, catalog_cluster, "/catalog-api/api/catalog/items/by", ["1.0", "1", "2.0"])
    catalog_route(yarp, catalog_cluster, "/catalog-api/api/catalog/items/{id}", ["1.0", "1", "2.0"])
    catalog_route(yarp, catalog_cluster, "/catalog-api/api/catalog/items/by/{name}", ["1.0", "1"])
    catalog_route(yarp, catalog_cluster, "/catalog-api/api/catalog/items/withsemanticrelevance/{text}", ["1.0", "1"])
    catalog_route(yarp, catalog_cluster, "/catalog-api/api/catalog/items/withsemanticrelevance", ["2.0"])
    catalog_route(yarp, catalog_cluster, "/catalog-api/api/catalog/items/type/{typeId}/brand/{brandId?}", ["1.0", "1"])
    catalog_route(yarp, catalog_cluster, "/catalog-api/api/catalog/items/type/all/brand/{brandId?}", ["1.0", "1"])
    catalog_route(yarp, catalog_cluster, "/catalog-api/api/catalog/catalogTypes", ["1.0", "1", "2.0"])
    catalog_route(yarp, catalog_cluster, "/catalog-api/api/catalog/catalogBrands", ["1.0", "1", "2.0"])
    catalog_route(yarp, catalog_cluster, "/catalog-api/api/catalog/items/{id}/pic", ["1.0", "1", "2.0"])

    yarp.add_route("/api/catalog/{*any}", catalog_cluster).with_match_route_query_parameter(
        [api_version(["1.0", "1", "2.0"])]
    )
    yarp.add_route("/api/orders/{*any}", ordering_api.get_endpoint("http")).with_match_route_query_parameter(
        [api_version(["1.0", "1"])]
    )
    yarp.add_route("/identity/{*any}", identity_api.get_endpoint("http")).with_transform_path_remove_prefix("/identity")


with create_builder() as builder:
    redis = builder.add_redis("redis")
    rabbit_mq = builder.add_rabbit_mq("eventbus").with_persistent_lifetime()
    postgres = (
        builder.add_postgres("postgres")
        .with_image("ankane/pgvector")
        .with_image_tag("latest")
        .with_persistent_lifetime()
    )

    catalog_db = postgres.add_database("catalogdb")
    identity_db = postgres.add_database("identitydb")
    order_db = postgres.add_database("orderingdb")
    webhooks_db = postgres.add_database("webhooksdb")

    identity_api = with_project_endpoints(
        (
            add_project(builder, "identity-api", project_path("Identity.API"), LAUNCH_PROFILE_NAME)
            .with_external_http_endpoints()
            .with_reference(identity_db)
            .with_http_health_check(path="/health")
        ),
        True,
    )

    identity_endpoint = identity_api.get_endpoint(LAUNCH_PROFILE_NAME)

    basket_api = with_project_endpoints(
        (
            add_project(builder, "basket-api", project_path("Basket.API"))
            .with_reference(redis)
            .with_reference(rabbit_mq)
            .wait_for(rabbit_mq)
            .with_env("Identity__Url", identity_endpoint)
        ),
    )

    catalog_api = with_project_endpoints(
        (
            add_project(builder, "catalog-api", project_path("Catalog.API"))
            .with_reference(rabbit_mq)
            .wait_for(rabbit_mq)
            .with_reference(catalog_db)
        ),
    )

    ordering_api = with_project_endpoints(
        (
            add_project(builder, "ordering-api", project_path("Ordering.API"))
            .with_reference(rabbit_mq)
            .wait_for(rabbit_mq)
            .with_reference(order_db)
            .wait_for(order_db)
            .with_http_health_check(path="/health")
            .with_env("Identity__Url", identity_endpoint)
        ),
    )

    with_project_endpoints(
        (
            add_project(builder, "order-processor", project_path("OrderProcessor"))
            .with_reference(rabbit_mq)
            .wait_for(rabbit_mq)
            .with_reference(order_db)
            .wait_for(ordering_api)
        ),
    )

    with_project_endpoints(
        add_project(builder, "payment-processor", project_path("PaymentProcessor")).with_reference(rabbit_mq).wait_for(
            rabbit_mq
        ),
    )

    webhooks_api = with_project_endpoints(
        (
            add_project(builder, "webhooks-api", project_path("Webhooks.API"))
            .with_reference(rabbit_mq)
            .wait_for(rabbit_mq)
            .with_reference(webhooks_db)
            .with_env("Identity__Url", identity_endpoint)
        ),
    )

    (
        builder.add_yarp("mobile-bff")
        .with_external_http_endpoints()
        .with_config(configure_mobile_bff_routes)
    )

    webhooks_client = with_project_endpoints(
        (
            add_project(builder, "webhooksclient", project_path("WebhookClient"), LAUNCH_PROFILE_NAME)
            .with_reference(webhooks_api)
            .with_env("IdentityUrl", identity_endpoint)
        ),
        True,
    )

    web_app = with_project_endpoints(
        (
            add_project(builder, "webapp", project_path("WebApp"), LAUNCH_PROFILE_NAME)
            .with_external_http_endpoints()
            .with_reference(basket_api)
            .with_reference(catalog_api)
            .with_reference(ordering_api)
            .with_reference(rabbit_mq)
            .wait_for(rabbit_mq)
            .wait_for(identity_api)
            .with_env("IdentityUrl", identity_endpoint)
        ),
        True,
    )

    web_app.with_env("CallBackUrl", web_app.get_endpoint(LAUNCH_PROFILE_NAME))
    webhooks_client.with_env("CallBackUrl", webhooks_client.get_endpoint(LAUNCH_PROFILE_NAME))

    (
        identity_api.with_env("BasketApiClient", basket_api.get_endpoint("http"))
        .with_env("OrderingApiClient", ordering_api.get_endpoint("http"))
        .with_env("WebhooksApiClient", webhooks_api.get_endpoint("http"))
        .with_env("WebhooksWebClient", webhooks_client.get_endpoint(LAUNCH_PROFILE_NAME))
        .with_env("WebAppClient", web_app.get_endpoint(LAUNCH_PROFILE_NAME))
    )

    builder.run()