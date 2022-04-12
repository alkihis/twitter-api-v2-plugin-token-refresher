# @twitter-api-v2/plugin-token-refresher

> Automatic OAuth2 user-context access token refresher plugin for twitter-api-v2

Twitter API v2 introduce a new way to handle user-context with OAuth2.
It gives access to simple tokens, named *Bearer tokens*, having a dedicated lifetime (usually 2 hours).

If your Twitter app uses user-context more than this time-range, you'll need to handle *token refreshes*.

A token refresh is a dedicated call to have a *fresh, new couple of access+refresh tokens*.

To smoothen usage of API v2, **this plugin allows you to completely overpass this limitation** and handles the refresh for you! When a 401 or a 403 error is received from Twitter, it will refresh token automatically and restart the pending request.

## Features

- Request retry, if a request fails because your token isn't up-to-date, plugin updates token then makes the request again!
- Concurrency, be sure that only one token refresh is made at a time (in a single-process context only! no support for concurrency within multiple processes)
- Preventive token refresh: When a request is about to be made, but the plugin knows that stored token is expired, token refresh is made immediately
- Hook to detect when tokens are updated, to ensure your database is always synced with current tokens
- Hook to log refresh errors

## Usage

```ts
import { TwitterApi } from 'twitter-api-v2'
import { TwitterApiAutoTokenRefresher } from '@twitter-api-v2/plugin-token-refresher'

const credentials = { clientId: '<oauth2 client ID>', clientSecret: '<oauth2 client secret>' }
// Obtained first through OAuth2 auth flow
const tokenStore = { accessToken: '', refreshToken: '' }

const autoRefresherPlugin = new TwitterApiAutoTokenRefresher({
  refreshToken: tokenStore.refreshToken,
  refreshCredentials: credentials,
  onTokenUpdate(token) {
    tokenStore.accessToken = token.accessToken
    tokenStore.refreshToken = token.refreshToken!
    // store in DB/Redis/...
  },
  onTokenRefreshError(error) {
    console.error('Refresh error', error)
  },
})

const client = new TwitterApi(tokenStore.accessToken, { plugins: [autoRefresherPlugin] })

// use {client}, if needed, token will be refreshed with {refreshToken}
```

## Full usage within a OAuth2 auth-flow

**Requirements**
- Client ID and Client secret (if applicable), obtainable from Twitter developer portal
  - We will refer to them as simple variables, `clientId` and `clientSecret`
- A web server, even the simpliest one like an `express` one, but we need one to "welcome back" the user after its redirection to Twitter
  - We suppose that you use `express`
  - You will need to have an absolute URL used to "welcome back" the user, we will refer to it as `callbackUrl`
- A store to handle login credentials and temporary tokens, it can be a simple JS object, a SQL database, a Redis server, etc
  - In this tutorial, we will use generic function calls.
    - `setLoginVerifierForState(state, verifier)`
    - `getLoginVerifierFromState(state): verifier`
    - `setLoginCredentials(twitterUserId, credentials)`
    - `getLoginCredentials(twitterUserId): credentials`

### Get user credentials with a 3-legged process

#### Generate a login link

First, obtain access to user credentials by redirecting the user to Twitter portal, in order to "accept" your app to be linked to their profile.

```ts
import { TwitterApi } from 'twitter-api-v2'

const loginClient = new TwitterApi({ clientId, clientSecret })

// Don't forget to specify 'offline.access' in scope list, you want to refresh your token later
const { url, codeVerifier, state } = loginClient.generateOAuth2AuthLink(callbackUrl, { scope: ['tweet.read', 'users.read', 'offline.access', ...] });

// Store {state} and {codeVerifier}
setLoginVerifierForState(state, codeVerifier)

// Redirect user to {url}
```

#### Get access token after user approval

Once user has clicked on `url`, approved your app, they will be redirected to `callbackUrl`.

This should match a route on your web server.
We will suppose you use `/callback` here, adjust with your configuration.

```ts
import { TwitterApi } from 'twitter-api-v2'

// We still need a client with same credentials as in step 1
const loginClient = new TwitterApi({ clientId, clientSecret })

app.get('/callback', async (req, res) => {
  // Extract state and code from query string
  const { state, code } = req.query;
  // Check if a verifier is associated with given state
  const codeVerifier = getLoginVerifierFromState(state)

  if (!codeVerifier || !code) {
    return res.status(400).send('You denied the app or your session expired!')
  }

  try {
    // Get tokens
    const { client, accessToken, refreshToken } = await client.loginWithOAuth2({ code, codeVerifier, redirectUri: callbackUrl })

    // Get user ID
    const concernedUser = await client.v2.me()

    // Store credentials
    setLoginCredentials(concernedUser.data.id, { accessToken, refreshToken })
  } catch (e) {
    return res.status(403).send('Invalid verifier or access tokens!')
  }
})
```

### Use user credentials and auto-refresh token

You now have credentials for user `{id}`. We will now use them.

```ts
import { TwitterApi } from 'twitter-api-v2'
import { TwitterApiAutoTokenRefresher } from '@twitter-api-v2/plugin-token-refresher'

const { accessToken, refreshToken } = getLoginCredentials(id)

const autoRefresherPlugin = new TwitterApiAutoTokenRefresher({
  refreshToken,
  refreshCredentials: { clientId, clientSecret },
  onTokenUpdate(token) {
    setLoginCredentials(id, token)
  },
})

const client = new TwitterApi(accessToken, { plugins: [autoRefresherPlugin] })

// - Now, make requests -
// If token is expired, it will automatically by renewed.

await client.v2.me()
```

## Miscellaneous

### Customize settings of client used to refresh token

If you want to change settings or apply plugins to client that is used to refresh token with your `clientId` and `clientSecret`,
give an instance of `TwitterApi` instead of your credentials:

```ts
const autoRefresherPlugin = new TwitterApiAutoTokenRefresher({
  refreshCredentials: new TwitterApi({ clientId, clientSecret }, { plugins: [rateLimitPlugin] }),
  ...
})
```
