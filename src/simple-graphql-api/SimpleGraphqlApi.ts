import { PubSub, PubSubEngine } from "apollo-server";
import { GraphQLSchema } from "graphql";
import gql from "graphql-tag";
import {
  IEpcpPublish,
  IPubSubEnginePublish,
  returnTypeNameForSubscriptionFieldName,
} from "../graphql-epcp-pubsub/EpcpPubSubMixin";
import { filterTable, ISimpleTable } from "../simple-table/SimpleTable";
import { IGraphqlSubscription } from "../subscriptions-transport-ws-over-http/GraphqlSubscription";
import {
  getSubscriptionOperationFieldName,
  IGraphqlWsStartMessage,
  isGraphqlWsStartMessage,
} from "../subscriptions-transport-ws-over-http/GraphqlWebSocketOverHttpConnectionListener";
import { gripChannelForSubscriptionWithoutArguments } from "../subscriptions-transport-ws-over-http/GraphqlWsGripChannelNamers";
import { IWebSocketOverHttpGraphqlSubscriptionContext } from "../subscriptions-transport-ws-over-http/WebSocketOverHttpGraphqlContext";
import { IContextForPublishingWithEpcp } from "../subscriptions-transport-ws-over-http/WebSocketOverHttpGraphqlContext";
import { WebSocketOverHttpPubsubMixin } from "../subscriptions-transport-ws-over-http/WebSocketOverHttpPubsubMixin";

interface IPost {
  /** post author */
  author: string;
  /** post body text */
  comment: string;
}

interface IPostController {
  /** add a post */
  addPost(post: IPost): IPost;
  /** get all posts */
  posts(): IPost[];
}

/** Constructor for a PostController that stores post in memory */
const PostController = (): IPostController => {
  const postStorage: IPost[] = [];
  const addPost = (post: IPost): IPost => {
    postStorage.push(post);
    return post;
  };
  const posts = (): IPost[] => {
    return postStorage.slice();
  };
  return {
    addPost,
    posts,
  };
};

enum SimpleGraphqlApiPubSubTopic {
  POST_ADDED = "POST_ADDED",
}

/** Common Subscription queries that can be passed to ApolloClient.subscribe() */
export const SimpleGraphqlApiSubscriptions = {
  postAdded() {
    return {
      query: gql`
        subscription {
          postAdded {
            author
            comment
          }
        }
      `,
      variables: {},
    };
  },
};

/** Factories for common mutations that can be passed to apolloClient.mutate() */
export const SimpleGraphqlApiMutations = {
  addPost(post: IPost) {
    return {
      mutation: gql`
        mutation AddPost($author: String!, $comment: String!) {
          addPost(author: $author, comment: $comment) {
            author
            comment
          }
        }
      `,
      variables: post,
    };
  },
};

interface ISimpleGraphqlApiOptions {
  /** controller that will handle storing/retrieving posts */
  postController?: IPostController;
  /** pubsub implementation that will be used by the gql schema resolvers */
  pubsub?: PubSubEngine;
}

/**
 * A GraphQL API from the apollo-server subscriptions docs: https://www.apollographql.com/docs/apollo-server/features/subscriptions/
 */
export const SimpleGraphqlApi = ({
  pubsub = new PubSub(),
  postController = PostController(),
}: ISimpleGraphqlApiOptions = {}) => {
  const typeDefs = gql`
    type Subscription {
      postAdded: Post
    }

    type Query {
      posts: [Post]
    }

    type Mutation {
      addPost(author: String, comment: String): Post
    }

    type Post {
      author: String
      comment: String
    }
  `;
  const resolvers = {
    Mutation: {
      async addPost(
        root: any,
        args: any,
        context: IContextForPublishingWithEpcp,
      ) {
        await WebSocketOverHttpPubsubMixin(context)(pubsub).publish(
          SimpleGraphqlApiPubSubTopic.POST_ADDED,
          {
            postAdded: args,
          },
        );
        return postController.addPost(args);
      },
    },
    Query: {
      posts(root: any, args: any, context: any) {
        return postController.posts();
      },
    },
    Subscription: {
      postAdded: {
        // Additional event labels can be passed to asyncIterator creation
        subscribe(
          rootValue: any,
          args: object,
          context: IWebSocketOverHttpGraphqlSubscriptionContext,
        ) {
          return WebSocketOverHttpPubsubMixin(context)(pubsub).asyncIterator([
            SimpleGraphqlApiPubSubTopic.POST_ADDED,
          ]);
        },
      },
    },
  };
  return {
    resolvers,
    typeDefs,
  };
};

/** Return a function that will return the Grip-Channel to use for each graphql-ws start message */
export const SimpleGraphqlApiGripChannelNamer = () => (
  gqlWsStartMessage: IGraphqlWsStartMessage,
): string => {
  return gripChannelForSubscriptionWithoutArguments(gqlWsStartMessage);
};

type PubSubEngineEpcpPublisher = (
  publish: IPubSubEnginePublish,
) => Promise<IEpcpPublish[]>;

/**
 * Convert SimpleGraphqlApi PubSubEngine publishes to EPCP Publishes that should be sent to a GRIP server.
 */
export const SimpleGraphqlApiEpcpPublisher = (options: {
  /** GraphQL Schema */
  graphqlSchema: GraphQLSchema;
  /** storage table for graphql-ws subscriptions */
  subscriptionStorage: ISimpleTable<IGraphqlSubscription>;
}): PubSubEngineEpcpPublisher => async (
  pubsubEnginePublish: IPubSubEnginePublish,
) => {
  switch (pubsubEnginePublish.triggerName) {
    case SimpleGraphqlApiPubSubTopic.POST_ADDED:
      const postAddedSubscriptions = await filterTable(
        options.subscriptionStorage,
        (subscription: IGraphqlSubscription) =>
          subscription.subscriptionFieldName === "postAdded",
      );
      // get a start message from one of the subscriptions
      const getStartMessageSample = () => {
        const subscription = postAddedSubscriptions[0];
        const startMessageSample =
          subscription && JSON.parse(subscription.startMessage);
        if (!isGraphqlWsStartMessage(startMessageSample)) {
          throw new Error(
            `Could not get sample startMessage, got ${startMessageSample}`,
          );
        }
        return startMessageSample;
      };
      const epcpPublishes: IEpcpPublish[] = postAddedSubscriptions
        .map(s => s.operationId)
        .reduce(uniqueReducer, [] as string[])
        .map(operationId => {
          const startMessageBase = getStartMessageSample();
          const subscriptionFieldName = getSubscriptionOperationFieldName(
            startMessageBase.payload,
          );
          const epcpPublish: IEpcpPublish = {
            channel: SimpleGraphqlApiGripChannelNamer()({
              ...startMessageBase,
              id: operationId,
            }),
            message: JSON.stringify({
              id: operationId,
              payload: {
                data: {
                  [subscriptionFieldName]: {
                    __typename: returnTypeNameForSubscriptionFieldName(
                      options.graphqlSchema,
                      subscriptionFieldName,
                    ),
                    ...pubsubEnginePublish.payload[subscriptionFieldName],
                  },
                },
              },
              type: "data",
            }),
          };
          return epcpPublish;
        });

      return epcpPublishes;
  }
  throw new Error(
    `SimpleGraphqlApiEpcpPublisher got unexpected PubSubEngine triggerName ${pubsubEnginePublish.triggerName} `,
  );
};

/** Array reducer that returns an array of the unique items of the reduced array */
function uniqueReducer<Item>(prev: Item[] | Item, curr: Item): Item[] {
  if (!Array.isArray(prev)) {
    prev = [prev];
  }
  if (prev.indexOf(curr) === -1) {
    prev.push(curr);
  }
  return prev;
}
