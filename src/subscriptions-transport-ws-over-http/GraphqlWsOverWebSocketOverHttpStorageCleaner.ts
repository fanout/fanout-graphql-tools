import { ISimpleTable } from "../simple-table/SimpleTable";
import { IGraphqlSubscription } from "./GraphqlSubscription";
import { IStoredConnection } from "./GraphqlWsOverWebSocketOverHttpExpressMiddleware";

export interface IGraphqlWsOverWebSocketOverHttpStorageCleanerOptions {
  /** table to store information about each ws-over-http connection */
  connectionStorage: ISimpleTable<IStoredConnection>;
  /** table to store information about each Graphql Subscription */
  subscriptionStorage: ISimpleTable<IGraphqlSubscription>;
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
            // Delete all subscriptions for connection
            await deleteSubscriptionsForConnection(
              options.subscriptionStorage,
              { id: connection.id },
            );
            // and delete the connection itself
            await options.connectionStorage.delete({ id: connection.id });
          }),
        );
        return true;
      },
    );
  };
};

/**
 * Delete all the subscriptions from subscriptionStorage that have subscription.connectionId equal to the provided connectionQuery.id
 */
async function deleteSubscriptionsForConnection(
  subscriptionStorage: ISimpleTable<IGraphqlSubscription>,
  connectionQuery: {
    /** Connection ID whose corresponding subscriptions should be deleted */
    id: string;
  },
): Promise<void> {
  await subscriptionStorage.scan(async subscriptions => {
    await Promise.all(
      subscriptions.map(async subscription => {
        if (subscription.connectionId === connectionQuery.id) {
          // This subscription is for the provided connection.id. Delete it.
          await subscriptionStorage.delete({ id: subscription.id });
        }
      }),
    );
    return true;
  });
}
