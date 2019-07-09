import { Observable } from "apollo-link";

/**
 * Given an observable, subscribe to it and return the subscription as well as an array that will be pushed to whenever an item is sent to subscription.
 */
export const itemsFromLinkObservable = <T>(
  observable: Observable<T>,
): {
  /** Array of items that have come from the subscription */
  items: T[];
  /** Subscription that can be unsubscribed to */
  subscription: ZenObservable.Subscription;
} => {
  const items: T[] = [];
  const subscription = observable.subscribe({
    next(item) {
      items.push(item);
    },
  });
  return { items, subscription };
};
