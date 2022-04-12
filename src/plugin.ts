import {
  TwitterApi,
  TwitterApiPluginResponseOverride,
  ITwitterApiClientPlugin,
  ITwitterApiResponseErrorHookArgs,
  ITwitterApiBeforeRequestConfigHookArgs,
  TwitterApiOAuth2Init,
  IParsedOAuth2TokenResult,
  ApiRequestError,
  ApiResponseError,
  ApiPartialResponseError,
} from 'twitter-api-v2';

const triedSymbol = Symbol();

declare module 'twitter-api-v2' {
  interface IGetHttpRequestArgs {
    [triedSymbol]?: boolean;
  }
}

export interface IAutoTokenRefresherArgs {
  refreshToken: string;
  refreshCredentials: TwitterApiOAuth2Init | TwitterApi;
  onTokenUpdate?: (newToken: IParsedOAuth2TokenResult) => void | Promise<void>;
  onTokenRefreshError?: (error: ApiRequestError | ApiResponseError | ApiPartialResponseError) => void;
}

export class TwitterApiAutoTokenRefresher implements ITwitterApiClientPlugin {
  protected refreshClient: TwitterApi;
  protected currentRefreshToken: string;
  protected tokenExpired = false;
  protected nextTokenExpireTimeout: NodeJS.Timeout | null = null;
  protected currentRefreshPromise: Promise<IParsedOAuth2TokenResult> | null = null;

  public constructor(protected options: IAutoTokenRefresherArgs) {
    this.refreshClient = options.refreshCredentials instanceof TwitterApi
      ? options.refreshCredentials
      : new TwitterApi(options.refreshCredentials);
    this.currentRefreshToken = options.refreshToken;
  }

  public async onBeforeRequestConfig(args: ITwitterApiBeforeRequestConfigHookArgs) {
    if (this.currentRefreshPromise) {
      await this.currentRefreshPromise;
    } else if (this.tokenExpired) {
      // If we know that token is expired, don't let request fail,
      // just do right now the token update!
      try {
        await this.refreshTokenFromRequestContext(args);
      } catch (e) {
        // Do nothing, let the request be made normally
      }
    }
  }

  public async onResponseError(args: ITwitterApiResponseErrorHookArgs) {
    const error = args.error;

    // If error is unauthorized and recursive symbol does not exists
    if ((error.code === 401 || error.code === 403) && !args.params[triedSymbol]) {
      // Start token refresh and ensure no more than one request can be made simultaneously
      try {
        await this.refreshTokenFromRequestContext(args);
      } catch (e) {
        // Quit here, original error will be thrown instead
        return;
      }

      // Will throw if request fails
      const response = await args.client.send(args.params);

      return new TwitterApiPluginResponseOverride(response);
    }

    // Unsupported error or recursive call: do nothing, error will be thrown normally
  }

  protected async refreshTokenFromRequestContext(args: ITwitterApiBeforeRequestConfigHookArgs | ITwitterApiResponseErrorHookArgs) {
    // Prevent recursivity
    args.params[triedSymbol] = true;

    // [THIS MEANS ORIGINAL ERROR WILL BE SKIPPED IF REFRESH TOKEN FAILS]
    // Share every possibile concurrent refresh token call
    try {
      const token = await this.getRefreshTokenPromise();
      // Set access token manually in client [THIS MUTATE THE INSTANCE]
      args.client.bearerToken = token.accessToken;
    } catch (error) {
      this.options.onTokenRefreshError?.(error as ApiRequestError | ApiResponseError | ApiPartialResponseError);
      // Re-throw error after logging
      throw error;
    }
  }

  protected getRefreshTokenPromise() {
    if (this.currentRefreshPromise) {
      return this.currentRefreshPromise;
    } else {
      return this.currentRefreshPromise = this.refreshToken();
    }
  }

  protected async refreshToken() {
    const token = await this.refreshClient.refreshOAuth2Token(this.currentRefreshToken);

    this.setExpireTimeout(token.expiresIn);

    // refreshToken is necesserly defined, as we just have refreshed a token
    this.currentRefreshToken = token.refreshToken!;
    this.tokenExpired = false;
    await this.options.onTokenUpdate?.(token);

    return token;
  }

  protected setExpireTimeout(expiresIn: number) {
    if (this.nextTokenExpireTimeout) {
      clearTimeout(this.nextTokenExpireTimeout);
      this.nextTokenExpireTimeout = null;
    }

    // Unset promise within 20 seconds of safety
    // No promise will cause requests to ask a new token if needed
    this.nextTokenExpireTimeout = setTimeout(() => {
      this.currentRefreshPromise = null;
      this.tokenExpired = true;
    }, (expiresIn - 20) * 1000);
    this.nextTokenExpireTimeout.unref();
  }
}

export default TwitterApiAutoTokenRefresher;
