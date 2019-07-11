import * as grip from "grip";
import * as pubcontrol from "pubcontrol";
import { parseGraphqlWsStartMessage } from "./GraphqlWebSocketOverHttpConnectionListener";
import { GraphqlWsGripChannelNamer } from "./GraphqlWsGripChannelNamers";
import { IStoredPubSubSubscription } from "./PubSubSubscriptionStorage";

export type ISubscriptionPublisher = (
  subscription: IStoredPubSubSubscription,
  messages: any[],
) => Promise<void>;

/** Publishes messages to provided connectionId via EPCP */
export const EpcpSubscriptionPublisher = (options: {
  /** grip options */
  grip: {
    /** Grip Control URL */
    url: string;
    /** Given a graphql-ws GQL_START message, return a string that is the Grip-Channel that the GRIP server should subscribe to for updates */
    getGripChannel: GraphqlWsGripChannelNamer;
  };
}): ISubscriptionPublisher => async (subscription, messages) => {
  const gripPubControl = new grip.GripPubControl(
    grip.parseGripUri(options.grip.url),
  );
  const subscriptionStartMessage = parseGraphqlWsStartMessage(
    subscription.graphqlWsStartMessage,
  );
  const gripChannelName = options.grip.getGripChannel({
    connectionId: subscription.connectionId,
    graphqlWsStartMessage: subscriptionStartMessage,
  });
  for (const message of messages) {
    const dataMessage = {
      id: subscriptionStartMessage.id,
      payload: message,
      type: "data",
    };
    const dataMessageString = JSON.stringify(dataMessage);
    await new Promise((resolve, reject) => {
      gripPubControl.publish(
        gripChannelName,
        new pubcontrol.Item(new grip.WebSocketMessageFormat(dataMessageString)),
        (success, error, context) => {
          console.log(
            `gripPubControl callback channel=${gripChannelName} success=${success} error=${error} context=${context} message=${dataMessageString}`,
          );
          if (success) {
            return resolve(context);
          }
          return reject(error);
        },
      );
    });
  }
};

/**
 * Filter an AsyncIterable of stored PubSub subscriptions to only return
 * one subscription per unique value of applying getGripChannel
 */
export const UniqueGripChannelNameSubscriptionFilterer = (options: {
  /** Given a graphql-ws GQL_START message, return a string that is the Grip-Channel that the GRIP server should subscribe to for updates */
  getGripChannel: GraphqlWsGripChannelNamer;
}) => {
  async function* filterSubscriptionsForUniqueGripChannel(
    subscriptions: AsyncIterable<IStoredPubSubSubscription>,
  ): AsyncIterable<IStoredPubSubSubscription> {
    const seenGripChannels = new Set<string>();
    for await (const s of subscriptions) {
      const gripChannel = options.getGripChannel({
        connectionId: s.connectionId,
        graphqlWsStartMessage: parseGraphqlWsStartMessage(
          s.graphqlWsStartMessage,
        ),
      });
      if (!seenGripChannels.has(gripChannel)) {
        yield s;
      }
      seenGripChannels.add(gripChannel);
    }
  }
  return filterSubscriptionsForUniqueGripChannel;
};

/** Create async filterer of IStoredSubscriptions that  */
export const UniqueConnectionIdOperationIdPairSubscriptionFilterer = () => {
  async function* filterSubscriptions(
    subscriptions: AsyncIterable<IStoredPubSubSubscription>,
  ): AsyncIterable<IStoredPubSubSubscription> {
    const seenConnectionOperationPairIds = new Set();
    for await (const s of subscriptions) {
      const connectionIdOperationIdPair = [
        s.connectionId,
        parseGraphqlWsStartMessage(s.graphqlWsStartMessage).id,
      ];
      const connectionOperationPairId = JSON.stringify(
        connectionIdOperationIdPair,
      );
      if (!seenConnectionOperationPairIds.has(connectionOperationPairId)) {
        yield s;
      }
      seenConnectionOperationPairIds.add(seenConnectionOperationPairIds);
    }
  }
  return filterSubscriptions;
};

export type IAsyncFilter<T> = (items: AsyncIterable<T>) => AsyncIterable<T>;

/** Generic IAsyncFilter that doesn't actually filter anything */
export const NoopAsyncFilterer = <T>(): IAsyncFilter<T> => {
  async function* filter(items: AsyncIterable<T>) {
    for await (const item of items) {
      yield item;
    }
  }
  return filter;
};
