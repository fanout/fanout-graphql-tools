# fanout-graphql-tools

Modules that help make GraphQL servers that work with [Fanout Cloud](https://fanout.io/cloud/).

See [fanout/apollo-demo](https://github.com/fanout/apollo-demo) for an example project that uses this to power a GraphQL API server with GraphQL Subscriptions on AWS Lambda.

## Development

### Releasing New Versions

Release a new version of this package by pushing a git tag with a name that is a semver version like "v0.0.2".
Make sure you also update the `package.json` to have the same version.

The best way to do this is using [`npm version <newversion>`](https://docs.npmjs.com/cli/version), which will update `package.json`, then create a git commit, then create a git tag pointing to that git commit. You should run this in the master branch.

After that you can push the commit and new tags using `git push --follow-tags`.

```
npm version minor
git push --follow-tags
```

[Travis](https://travis-ci.org/fanout/fanout-graphql-tools) is configured to test and publish all git tags to [npm](https://www.npmjs.com/package/fanout-graphql-tools). You don't need to run `npm publish` locally.

