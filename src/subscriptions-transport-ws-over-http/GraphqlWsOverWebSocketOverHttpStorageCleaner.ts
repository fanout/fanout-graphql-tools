import { ISimpleTable } from "../simple-table/SimpleTable";
import { IStoredConnection } from "./GraphqlWsOverWebSocketOverHttpExpressMiddleware";
import { IStoredPubSubSubscription } from "./PubSubSubscriptionStorage";

export interface IGraphqlWsOverWebSocketOverHttpStorageCleanerOptions {
  /** table to store information about each ws-over-http connection */
  connectionStorage: ISimpleTable<IStoredConnection>;
  /** table to store PubSub subscription info in */
  pubSubSubscriptionStorage: ISimpleTable<IStoredPubSubSubscription>;
}

/**
 * Object that knows how to clean up old records in storage created by other subscriptions-transport-ws-over-http logic.
 * ConnectionStoringConnectionListener will try to keep aa `connection.expiresAt` field up to date to detect when a connection should 'timeout' and be treated as gone forever.
 * This Cleaner is a function that, when called, will delete all the connections whose expiresAt is in the past, and for each of those connections, any corresponding subscriptions.
 */
export const GraphqlWsOverWebSocketOverHttpStorageCleaner = (
  options: IGraphqlWsOverWebSocketOverHttpStorageCleanerOptions,
) => {
  /**
   * @param now {Date|undefined} Time to consider now when comparing against connection.expiresAt. If not present, will use now. But pass a value to, for example, simulate a future datetime
   */
  return async (now?: Date) => {
    await options.connectionStorage.scan(
      async (connections: IStoredConnection[]) => {
        await Promise.all(
          connections.map(async connection => {
            const parsedExpiresAt = Date.parse(connection.expiresAt);
            if (isNaN(parsedExpiresAt)) {
              console.log(
                `Failed to parse connection.expiresAt value as date: id=${connection.id} expiresAt=${connection.expiresAt}`,
              );
              return;
            }
            const expiresAtDate = new Date(parsedExpiresAt);
            if ((now || new Date()) < expiresAtDate) {
              // connection hasn't expired yet
              return;
            }
            // connection has expired.
            await cleanupStorageAfterConnection({
              connection,
              ...options,
            });
          }),
        );
        return true;
      },
    );
  };
};

/**
 * Cleanup the stored rows associated with a connection when it is no longer needed.
 * i.e. delete the connection record, but also any subscription rows created on that connection.
 */
export const cleanupStorageAfterConnection = async (options: {
  /** table to store information about each ws-over-http connection */
  connectionStorage: ISimpleTable<IStoredConnection>;
  /** table to store info about each PubSub subscription created by graphql subscription resolvers */
  pubSubSubscriptionStorage: ISimpleTable<IStoredPubSubSubscription>;
  /** connection to cleanup */
  connection: {
    /** connection id of connection to cleanup after */
    id: string;
  };
}) => {
  const { connection } = options;
  // Delete all subscriptions for connection
  await deletePubSubSubscriptionsForConnection(
    options.pubSubSubscriptionStorage,
    connection,
  );
  // and delete the connection itself
  await options.connectionStorage.delete({ id: connection.id });
};

/**
 * Delete all the stored PubSub subscriptions from pubSubSubscriptionStorage that were created for the provided connectionId
 */
async function deletePubSubSubscriptionsForConnection(
  pubSubSubscriptionStorage: ISimpleTable<IStoredPubSubSubscription>,
  connectionQuery: {
    /** Connection ID whose corresponding subscriptions should be deleted */
    id: string;
  },
) {
  await pubSubSubscriptionStorage.scan(async pubSubSubscriptions => {
    await Promise.all(
      pubSubSubscriptions.map(async pubSubSubscription => {
        if (pubSubSubscription.connectionId === connectionQuery.id) {
          // This pubSubSubscription is for the provided connection.id. Delete it.
          await pubSubSubscriptionStorage.delete({ id: pubSubSubscription.id });
        }
      }),
    );
    return true;
  });
}
