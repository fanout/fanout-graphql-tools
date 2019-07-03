import { PubSubEngine } from "apollo-server";
import { v4 as uuidv4 } from "uuid";
import { ISimpleTable } from "../simple-table/SimpleTable";
import { IStoredPubSubSubscription } from "./PubsubSubscriptionStorage";

/** Wrap a PubSubEngine so that calls to .subscribe are stored */
export const SubscriptionStoragePubSubMixin = (options: {
  /** table to store PubSub subscription info in */
  pubSubSubscriptionStorage: ISimpleTable<IStoredPubSubSubscription>;
}) => (pubsub: PubSubEngine) => {
  console.log("in SubscriptionStoragePubSubMixin");
  // defer to pubsub.subscribe, but also store the subscription
  const subscribe: PubSubEngine["subscribe"] = async (
    triggerName,
    onMessage,
    subscribeOptions,
  ): Promise<number> => {
    const subscribeReturn = await pubsub.subscribe(
      triggerName,
      onMessage,
      subscribeOptions,
    );
    await options.pubSubSubscriptionStorage.insert({
      createdAt: new Date().toISOString(),
      eventName: triggerName,
      id: uuidv4(),
    });
    return subscribeReturn;
  };
  const pubSubWithStorage: PubSubEngine = Object.assign(Object.create(pubsub), {
    // asyncIterator: PubSubEngine.prototype.asyncIterator,
    subscribe,
  });
  return pubSubWithStorage;
};
