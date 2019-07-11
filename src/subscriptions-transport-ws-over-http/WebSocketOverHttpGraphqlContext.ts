import { GraphQLSchema } from "graphql";
import { ISimpleTable } from "../simple-table/SimpleTable";
import {
  EpcpSubscriptionPublisher,
  UniqueConnectionIdOperationIdPairSubscriptionFilterer,
  NoopAsyncFilterer,
} from "./EpcpSubscriptionPublisher";
import { IGraphqlWsStartMessage } from "./GraphqlWebSocketOverHttpConnectionListener";
import {
  DefaultGripChannelNamer,
  GraphqlWsGripChannelNamer,
} from "./GraphqlWsGripChannelNamers";
import { IStoredPubSubSubscription } from "./PubSubSubscriptionStorage";
import {
  IPubSubEnginePublish,
  PubSubSubscriptionsForPublishFromStorageGetter,
} from "./SubscriptionStoragePubSubMixin";

/** Interface for graphql server context when the request is coming via graphql-ws over websocket-over-http */
export interface IContextForPublishingWithEpcp {
  /** info about the webSocketOverHttp context */
  epcpPublishing?: {
    /** graphql context */
    graphql: {
      /** graphql Schema */
      schema: GraphQLSchema;
    };
    /** get the relevant pubSubSubscriptions for a PubSub publish (e.g. read from storage) */
    getPubSubSubscriptionsForPublish(
      publish: IPubSubEnginePublish,
    ): AsyncIterable<IStoredPubSubSubscription>;
    /** publish to a connection */
    publish(
      subscription: IStoredPubSubSubscription,
      messages: any[],
    ): Promise<void>;
  };
}

export interface IWebSocketOverHttpGraphqlSubscriptionContext {
  /** info about the webSocketOverHttp context */
  webSocketOverHttp?: {
    /** websocket-over-http connection info */
    connection: {
      /** connection id */
      id: string;
    };
    /** graphql context */
    graphql: {
      /** graphql Schema */
      schema: GraphQLSchema;
    };
    /** graphql-ws context */
    graphqlWs: {
      /** start message of this graphql-ws subscription */
      startMessage: IGraphqlWsStartMessage;
    };
    /** table to store PubSub subscription info in */
    pubSubSubscriptionStorage: ISimpleTable<IStoredPubSubSubscription>;
  };
}

type IAsyncFilter<T> = (items: AsyncIterable<T>) => AsyncIterable<T>;
interface IGraphqlWsGripChannelSharingStrategy {
  /** Given a graphql-ws GQL_START message, return a string that is the Grip-Channel that the GRIP server should subscribe to for updates */
  getGripChannel: GraphqlWsGripChannelNamer;
  /** given a PubSubEngine.publish from a mutation, return an AsyncFilterer that decides which relevant subscriptions can be deemed identical for the sake of simulating the resolvers and publishing results via EPCP */
  getSubscriptionFilterForPublish(
    publish: IPubSubEnginePublish,
  ): IAsyncFilter<IStoredPubSubSubscription>;
}

/** ContextFunction that can be passed to ApolloServerOptions["context"] that will provide required context for WebSocket-Over-HTTP PubSub mixin */
export const WebSocketOverHttpContextFunction = (options: {
  /** graphql schema */
  schema: GraphQLSchema;
  /** storage for pubSubScriptionStorage */
  pubSubSubscriptionStorage: ISimpleTable<IStoredPubSubSubscription>;
  /** grip uri */
  grip: {
    /** GRIP URI for EPCP Gateway */
    url: string;
    /** Given a graphql-ws GQL_START message, return a string that is the Grip-Channel that the GRIP server should subscribe to for updates */
    getGripChannel?: GraphqlWsGripChannelNamer;
    /** strategy for sharing grip channels */
    getSubscriptionFilterForPublish?(
      publish: IPubSubEnginePublish,
    ): IAsyncFilter<IStoredPubSubSubscription>;
  };
}) => {
  const channelSharingStrategy: IGraphqlWsGripChannelSharingStrategy = {
    getGripChannel: options.grip.getGripChannel || DefaultGripChannelNamer(),
    getSubscriptionFilterForPublish: (
      publish: IPubSubEnginePublish,
    ): IAsyncFilter<IStoredPubSubSubscription> =>
      options.grip && options.grip.getSubscriptionFilterForPublish
        ? options.grip.getSubscriptionFilterForPublish(publish)
        : NoopAsyncFilterer(),
  };
  const context: IContextForPublishingWithEpcp = {
    epcpPublishing: {
      getPubSubSubscriptionsForPublish(publish) {
        const storedSubscriptions = PubSubSubscriptionsForPublishFromStorageGetter(
          options.pubSubSubscriptionStorage,
        )(publish);
        const filtered = channelSharingStrategy.getSubscriptionFilterForPublish(
          publish,
        )(storedSubscriptions);
        return filtered;
      },
      graphql: {
        schema: options.schema,
      },
      publish: EpcpSubscriptionPublisher({
        grip: {
          ...options.grip,
          getGripChannel: channelSharingStrategy.getGripChannel,
        },
      }),
    },
  };
  return context;
};
