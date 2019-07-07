import { PubSub, PubSubEngine } from "apollo-server";
import * as graphql from "graphql";
import { createAsyncIterator, isAsyncIterable } from "iterall";
import { v4 as uuidv4 } from "uuid";
import { IPubSubEnginePublish } from "../graphql-epcp-pubsub/EpcpPubSubMixin";
import { ISimpleTable } from "../simple-table/SimpleTable";
import { IWebSocketOverHTTPConnectionInfo } from "../websocket-over-http-express/WebSocketOverHttpExpress";
import {
  IGraphqlWsStartMessage,
  isGraphqlWsStartMessage,
} from "./GraphqlWebSocketOverHttpConnectionListener";
import { IStoredPubSubSubscription } from "./PubSubSubscriptionStorage";

export interface ISubscriptionTestPubSub {
  /** return an asyncIterator of the provided triggerName publishes */
  asyncIterator: PubSubEngine["asyncIterator"];
}

/**
 * Create a PubSub that can only be subscribed to, and will publish a finite set of events passed on construction
 * @param publishes Crea
 */
function PrePublishedPubSub(publishes: IPubSubEnginePublish[]): PubSubEngine {
  const asyncIterator = (triggerName: string | string[]) => {
    const triggerNames = Array.isArray(triggerName)
      ? triggerName
      : [triggerName];
    const ai = createAsyncIterator(
      publishes
        .filter(p => triggerNames.includes(p.triggerName))
        .map(p => p.payload),
    );
    return ai;
  };
  return Object.assign(new PubSub(), {
    asyncIterator,
  });
}

export interface ISubscriptionTestGraphqlContext {
  /** subscription test context */
  subscriptionTest: {
    /** pubsub to use with subscription resolver during subscription test */
    pubsub: PubSubEngine;
  };
}

/** Wrap a PubSubEngine so that calls to .subscribe are stored */
export const SubscriptionStoragePubSubMixin = (options: {
  /** websocket-over-http connection */
  connection: {
    /** connection id */
    id: string;
  };
  /** graphql context */
  graphql: {
    /** graphql schema */
    schema: graphql.GraphQLSchema;
  };
  /** graphql-ws context */
  graphqlWs: {
    /** start message of this graphql-ws subscription */
    startMessage: IGraphqlWsStartMessage;
  };
  /** table to store PubSub subscription info in */
  pubSubSubscriptionStorage: ISimpleTable<IStoredPubSubSubscription>;
}) => (pubsub: PubSubEngine) => {
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
      connectionId: options.connection.id,
      createdAt: new Date().toISOString(),
      graphqlWsStartMessage: JSON.stringify(options.graphqlWs.startMessage),
      id: uuidv4(),
      triggerName,
    });
    return subscribeReturn;
  };
  const pubSubWithStorage: PubSubEngine = Object.assign(Object.create(pubsub), {
    subscribe,
  });
  return pubSubWithStorage;
};

/**
 * PubSub mixin that will patch publish method to also publish to stored pubSubSubscriptions
 */
export const PublishToStoredSubscriptionsPubSubMixin = (options: {
  /** graphql context */
  graphql: {
    /** graphql schema */
    schema: graphql.GraphQLSchema;
  };
  /** table to store PubSub subscription info in */
  pubSubSubscriptionStorage: ISimpleTable<IStoredPubSubSubscription>;
  /** publish to a connection */
  publish(
    subscription: IStoredPubSubSubscription,
    messages: any[],
  ): Promise<void>;
}) => (pubsub: PubSubEngine): PubSubEngine => {
  // defer to pubsub.publish, but also publish to stored connections that were subscribing to triggerName
  const publish: PubSubEngine["publish"] = async (
    triggerName: string,
    payload: any,
  ): Promise<void> => {
    await pubsub.publish(triggerName, payload);
    /**
     * For each stored PubSub Subscription, if it was for this eventName, consider publishing to it
     * @todo consider abstracting SimpleTable interface behind a more generic AsyncIterator interface
     */
    await options.pubSubSubscriptionStorage.scan(
      async (
        pubSubSubscriptions: IStoredPubSubSubscription[],
      ): Promise<boolean> => {
        await Promise.all(
          pubSubSubscriptions
            .filter(
              storedSubscription =>
                storedSubscription.triggerName === triggerName,
            )
            .map(async storedSubscription => {
              // This storedSubscription was listening for this triggerName.
              // That means it's listening for it but may still do further filtering.
              const fakePubSub = PrePublishedPubSub([{ triggerName, payload }]);
              const storedSubscriptionGraphqlWsStartMessage = JSON.parse(
                storedSubscription.graphqlWsStartMessage,
              );
              if (
                !isGraphqlWsStartMessage(
                  storedSubscriptionGraphqlWsStartMessage,
                )
              ) {
                throw new Error(
                  `couldn't parse storedSubscription graphql-ws start message`,
                );
              }
              const operation = storedSubscriptionGraphqlWsStartMessage.payload;
              const contextValue: ISubscriptionTestGraphqlContext = {
                subscriptionTest: {
                  pubsub: fakePubSub,
                },
              };
              const subscriptionResult = await graphql.subscribe({
                contextValue,
                document: graphql.parse(operation.query),
                operationName: operation.operationName,
                schema: options.graphql.schema,
                variableValues: operation.variables,
              });
              if (isAsyncIterable(subscriptionResult)) {
                const subscriptionResultItems = [];
                for await (const result of subscriptionResult) {
                  subscriptionResultItems.push(result);
                }
                await options.publish(
                  storedSubscription,
                  subscriptionResultItems,
                );
              }
            }),
        );
        return true;
      },
    );
  };
  const pubSubWithStorage: PubSubEngine = Object.assign(Object.create(pubsub), {
    publish,
  });
  return pubSubWithStorage;
};
