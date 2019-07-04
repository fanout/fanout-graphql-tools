/**
 * Objects for storing info about apollo PubSubEngine subscriptions.
 */

export interface IStoredPubSubSubscription {
  /** websocket-over-http connection.id */
  connectionId: string;
  /** date the subscription was stored. As [ISO_8601](http://en.wikipedia.org/wiki/ISO_8601) UTC string */
  createdAt: string;
  /** graphql-ws start message for this subscription */
  graphqlWsStartMessage: string;
  /** the PubSubEngine triggerName that was subscribed to (e.g. `PubSubEngine#asyncIterator([EVENT_NAME])`) */
  triggerName: string;
  /** unique identifier for the subscription */
  id: string;
}
