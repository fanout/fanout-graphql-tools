/**
 * Objects for storing info about apollo PubSubEngine subscriptions.
 */

export interface IStoredPubSubSubscription {
  /** date the subscription was stored. As [ISO_8601](http://en.wikipedia.org/wiki/ISO_8601) UTC string */
  createdAt: string;
  /** the PubSubEngine event name that was subscribed to (e.g. `PubSubEngine#asyncIterator([EVENT_NAME])`) */
  eventName: string;
  /** unique identifier for the subscription */
  id: string;
}
