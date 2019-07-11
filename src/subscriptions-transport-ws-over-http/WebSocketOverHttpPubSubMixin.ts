import { PubSubEngine } from "apollo-server";
import {
  ISubscriptionTestGraphqlContext,
  PublishToStoredSubscriptionsPubSubMixin,
  SubscriptionStoragePubSubMixin,
} from "./SubscriptionStoragePubSubMixin";
import {
  IContextForPublishingWithEpcp,
  IWebSocketOverHttpGraphqlSubscriptionContext,
} from "./WebSocketOverHttpGraphqlContext";

enum FanoutGraphqlToolsContextKeys {
  subscriptionTest = "subscriptionTest",
  webSocketOverHttp = "webSocketOverHttp",
  epcpPublishing = "epcpPublishing",
}

/**
 * Given graphql resolver context, return a PubSub mixin that will do what is needed
 * to enable subscriptions over ws-over-http
 */
export const WebSocketOverHttpPubSubMixin = (
  context:
    | IWebSocketOverHttpGraphqlSubscriptionContext
    | IContextForPublishingWithEpcp
    | ISubscriptionTestGraphqlContext,
) => (pubsubIn: PubSubEngine): PubSubEngine => {
  let pubsub = pubsubIn;
  if ("subscriptionTest" in context) {
    pubsub = context.subscriptionTest.pubsub;
  }
  if ("webSocketOverHttp" in context && context.webSocketOverHttp) {
    pubsub = SubscriptionStoragePubSubMixin(context.webSocketOverHttp)(pubsub);
  }
  if ("epcpPublishing" in context && context.epcpPublishing) {
    pubsub = PublishToStoredSubscriptionsPubSubMixin(context.epcpPublishing)(
      pubsub,
    );
  }
  if (
    Object.keys(context).filter(contextKey =>
      Object.keys(FanoutGraphqlToolsContextKeys).includes(contextKey),
    ).length === 0
  ) {
    console.warn(
      "WebSocketOverHttpPubSubMixin found no FanoutGraphqlToolsContextKeys in GraphQL Context. Did you remember to use WebSocketOverHttpContextFunction when constructing ApolloServer()?",
    );
  }
  return pubsub;
};
