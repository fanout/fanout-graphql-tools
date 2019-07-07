import { PubSub, PubSubEngine } from "apollo-server";
import gql from "graphql-tag";
import { IGraphqlWsStartMessage } from "../subscriptions-transport-ws-over-http/GraphqlWebSocketOverHttpConnectionListener";
import { gripChannelForSubscriptionWithoutArguments } from "../subscriptions-transport-ws-over-http/GraphqlWsGripChannelNamers";
import { IWebSocketOverHttpGraphqlSubscriptionContext } from "../subscriptions-transport-ws-over-http/WebSocketOverHttpGraphqlContext";
import { IContextForPublishingWithEpcp } from "../subscriptions-transport-ws-over-http/WebSocketOverHttpGraphqlContext";
import { WebSocketOverHttpPubSubMixin } from "../subscriptions-transport-ws-over-http/WebSocketOverHttpPubSubMixin";

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
        await WebSocketOverHttpPubSubMixin(context)(pubsub).publish(
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
          return WebSocketOverHttpPubSubMixin(context)(pubsub).asyncIterator([
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
