export interface IGraphqlSubscriptionsMessageHandlerOptions {
    /** Called with graphql-ws start event. Return messages to respond with */
    onStart?(startEvent: object): void | string;
}
declare const _default: (opts?: IGraphqlSubscriptionsMessageHandlerOptions) => (message: string) => string | void;
/**
 * WebSocket Message Handler that does a minimal handshake of graphql-ws.
 * It will allow all incoming connections, but won't actually send anything to the subscriber.
 * It's intended that messages will be published to subscribers out of band.
 */
export default _default;
