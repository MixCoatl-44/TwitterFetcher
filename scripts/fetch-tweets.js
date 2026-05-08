/**
 * fetch-tweets.js
 *
 * Checks the last tweet from each monitored account,
 * compares against last seen tweet ID,
 * and forwards any new tweets to Telegram in chronological order.
 *
 * Twitter API cost: 1 request per account per run = 4 requests per run
 * At 25 runs/month = 100 requests (free tier limit)
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// ─── Configuration ────────────────────────────────────────────────

const CONFIG = {
  ACCOUNTS: [
    'TrueCrypto28',
    'IncomeSharks',
    'RafaelH117',
    'barcauniversal',
  ],
  STATE_FILE: path.join(__dirname, '../state/seen.json'),
  // How many tweets to fetch per account per check
  // Keep at 5 — catches bursts without wasting requests
  TWEETS_PER_ACCOUNT: 5,
  DRY_RUN: process.argv.includes('--dry-run'),
};

// ─── Required environment variables ───────────────────────────────

const REQUIRED_ENV = [
  'TWITTER_API_KEY',
  'TWITTER_API_SECRET',
  'TWITTER_ACCESS_TOKEN',
  'TWITTER_ACCESS_TOKEN_SECRET',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
];

// ─── Utilities ────────────────────────────────────────────────────

function checkEnv() {
  const missing = REQUIRED_ENV.filter(v => !process.env[v]);
  if (missing.length > 0) {
    throw new Error(`Missing environment variables: ${missing.join(', ')}`);
  }
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG.STATE_FILE, 'utf8'));
  } catch {
    console.log('No state file found, starting fresh');
    return {};
  }
}

function saveState(state) {
  state.lastChecked = new Date().toISOString();
  fs.writeFileSync(
    CONFIG.STATE_FILE,
    JSON.stringify(state, null, 2) + '\n',
    'utf8'
  );
}

/**
 * Makes an HTTPS GET request and returns parsed JSON.
 * Uses Node's built-in https module — no extra dependencies needed.
 */
function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'User-Agent': 'TwitterFetcher/1.0',
        ...headers,
      },
    };
    https.get(url, options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 429) {
          reject(new Error('RATE_LIMITED: Twitter API rate limit hit'));
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error(`Failed to parse JSON: ${data}`));
        }
      });
    }).on('error', reject);
  });
}

/**
 * Makes an HTTPS POST request and returns parsed JSON.
 * Used for sending Telegram messages.
 */
function httpsPost(hostname, path, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const options = {
      hostname,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
        'User-Agent': 'TwitterFetcher/1.0',
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error(`Failed to parse Telegram response: ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

/**
 * Generates OAuth 1.0a authorization header.
 * Twitter API v2 requires this for user-context requests.
 * Implements HMAC-SHA1 signing manually using Node's crypto module.
 */
function buildOAuthHeader(method, url, oauthParams, consumerSecret, tokenSecret) {
  const crypto = require('crypto');

  // Collect all parameters for the signature base string
  const allParams = { ...oauthParams };

  // Sort and encode parameters
  const paramString = Object.keys(allParams)
    .sort()
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(allParams[k])}`)
    .join('&');

  // Build signature base string
  const baseString = [
    method.toUpperCase(),
    encodeURIComponent(url),
    encodeURIComponent(paramString),
  ].join('&');

  // Build signing key
  const signingKey = `${encodeURIComponent(consumerSecret)}&${encodeURIComponent(tokenSecret)}`;

  // Generate HMAC-SHA1 signature
  const signature = crypto
    .createHmac('sha1', signingKey)
    .update(baseString)
    .digest('base64');

  // Build Authorization header
  const headerParams = {
    ...oauthParams,
    oauth_signature: signature,
  };

  const headerStr = 'OAuth ' + Object.keys(headerParams)
    .sort()
    .map(k => `${encodeURIComponent(k)}="${encodeURIComponent(headerParams[k])}"`)
    .join(', ');

  return headerStr;
}

/**
 * Fetches recent tweets for a given username using Twitter API v2.
 * Returns array of tweet objects sorted oldest-first.
 * sinceId — if provided, only fetches tweets newer than this ID.
 */
async function fetchTweets(username, sinceId) {
  const crypto = require('crypto');

  // Step 1: Resolve username to user ID
  // This costs 1 request but is required for v2 timeline endpoint
  const userUrl = `https://api.twitter.com/2/users/by/username/${username}`;

  const oauthParamsUser = {
    oauth_consumer_key: process.env.TWITTER_API_KEY,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: process.env.TWITTER_ACCESS_TOKEN,
    oauth_version: '1.0',
  };

  const authHeaderUser = buildOAuthHeader(
    'GET',
    userUrl,
    oauthParamsUser,
    process.env.TWITTER_API_SECRET,
    process.env.TWITTER_ACCESS_TOKEN_SECRET
  );

  const userResponse = await httpsGet(userUrl, { Authorization: authHeaderUser });

  if (!userResponse.data) {
    throw new Error(`User not found: ${username}`);
  }

  const userId = userResponse.data.id;

  // Step 2: Fetch timeline
  // tweet.fields gives us created_at and author info
  // expansions gives us referenced tweets (for retweets)
  let timelineUrl = `https://api.twitter.com/2/users/${userId}/tweets` +
    `?max_results=${CONFIG.TWEETS_PER_ACCOUNT}` +
    `&tweet.fields=created_at,text,referenced_tweets` +
    `&expansions=referenced_tweets.id` +
    `&exclude=replies`;

  // If we have a previous tweet ID, only fetch newer ones
  // This is the deduplication mechanism
  if (sinceId && sinceId !== null) {
    timelineUrl += `&since_id=${sinceId}`;
  }

  const oauthParamsTimeline = {
    oauth_consumer_key: process.env.TWITTER_API_KEY,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: process.env.TWITTER_ACCESS_TOKEN,
    oauth_version: '1.0',
  };

  const authHeaderTimeline = buildOAuthHeader(
    'GET',
    // OAuth signature uses URL without query params
    `https://api.twitter.com/2/users/${userId}/tweets`,
    oauthParamsTimeline,
    process.env.TWITTER_API_SECRET,
    process.env.TWITTER_ACCESS_TOKEN_SECRET
  );

  const timelineResponse = await httpsGet(timelineUrl, {
    Authorization: authHeaderTimeline,
  });

  // No new tweets since last check
  if (!timelineResponse.data || timelineResponse.data.length === 0) {
    return [];
  }

  // Sort oldest first so Telegram receives them in chronological order
  return timelineResponse.data.sort((a, b) => {
    return new Date(a.created_at) - new Date(b.created_at);
  });
}

/**
 * Formats a tweet into a Telegram message string.
 * Uses Telegram's MarkdownV2 format.
 */
function formatTweetMessage(username, tweet) {
  // Format the timestamp
  const date = new Date(tweet.created_at);
  const formatted = date.toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  }) + ' UTC';

  // Detect if this is a retweet
  const isRetweet = tweet.referenced_tweets &&
    tweet.referenced_tweets.some(r => r.type === 'retweeted');
  const label = isRetweet ? '🔁 Retweet by' : '🐦 New tweet from';

  const tweetUrl = `https://twitter.com/${username}/status/${tweet.id}`;

  // Plain text message — easier than MarkdownV2 escaping
  const message =
    `${label} @${username}\n` +
    `━━━━━━━━━━━━━━━\n` +
    `${tweet.text}\n\n` +
    `🕐 ${formatted}\n` +
    `🔗 ${tweetUrl}`;

  return message;
}

/**
 * Sends a message to Telegram.
 * Splits long messages automatically (Telegram limit is 4096 chars).
 */
async function sendToTelegram(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const apiPath = `/bot${token}/sendMessage`;

  // Telegram max message length is 4096 characters
  const MAX_LENGTH = 4096;
  const chunks = [];
  for (let i = 0; i < message.length; i += MAX_LENGTH) {
    chunks.push(message.substring(i, i + MAX_LENGTH));
  }

  for (const chunk of chunks) {
    const body = {
      chat_id: chatId,
      text: chunk,
      disable_web_page_preview: false,
    };

    const result = await httpsPost('api.telegram.org', apiPath, body);

    if (!result.ok) {
      throw new Error(`Telegram API error: ${JSON.stringify(result)}`);
    }

    // Small delay between chunks to avoid Telegram rate limiting
    if (chunks.length > 1) {
      await new Promise(r => setTimeout(r, 500));
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────

async function main() {
  console.log('='.repeat(50));
  console.log('Tweet Fetcher Starting');
  console.log(`Mode: ${CONFIG.DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.log(`Time: ${new Date().toISOString()}`);
  console.log(`Monitoring: ${CONFIG.ACCOUNTS.join(', ')}`);
  console.log('='.repeat(50));

  if (!CONFIG.DRY_RUN) {
    checkEnv();
  }

  const state = loadState();
  console.log('\nLoaded state:', JSON.stringify(state, null, 2));

  // Collect all new tweets across all accounts with their account tag
  // We sort everything chronologically at the end before sending
  const allNewTweets = [];

  for (const username of CONFIG.ACCOUNTS) {
    console.log(`\nChecking @${username}...`);

    const lastSeenId = state[username] || null;
    console.log(`  Last seen ID: ${lastSeenId || 'none (first run)'}`);

    if (CONFIG.DRY_RUN) {
      console.log(`  [DRY RUN] Would fetch tweets since ID: ${lastSeenId}`);
      continue;
    }

    try {
      const tweets = await fetchTweets(username, lastSeenId);
      console.log(`  Found ${tweets.length} new tweet(s)`);

      for (const tweet of tweets) {
        allNewTweets.push({ username, tweet });
      }

      // Update state with the newest tweet ID we saw
      // Even if we had no new tweets, keep the existing state
      if (tweets.length > 0) {
        // tweets are sorted oldest-first, so last item is newest
        state[username] = tweets[tweets.length - 1].id;
        console.log(`  Updated last seen ID to: ${state[username]}`);
      }

      // Respect Twitter rate limiting between account checks
      // 1 second between requests is sufficient for free tier
      await new Promise(r => setTimeout(r, 1000));

    } catch (error) {
      if (error.message.startsWith('RATE_LIMITED')) {
        console.error(`  ⚠️  Rate limited by Twitter. Stopping early.`);
        console.error(`  Tweets fetched so far will still be sent.`);
        // Don't throw — save what we have and send what we can
        break;
      }
      console.error(`  ❌ Error fetching @${username}: ${error.message}`);
      // Continue to next account rather than crashing entirely
    }
  }

  // Sort all collected tweets chronologically across all accounts
  allNewTweets.sort((a, b) => {
    return new Date(a.tweet.created_at) - new Date(b.tweet.created_at);
  });

  console.log(`\nTotal new tweets to send: ${allNewTweets.length}`);

  // Send to Telegram in chronological order
  for (const { username, tweet } of allNewTweets) {
    const message = formatTweetMessage(username, tweet);

    console.log(`\nSending tweet from @${username} (${tweet.id})`);
    console.log(`  Posted at: ${tweet.created_at}`);

    try {
      await sendToTelegram(message);
      console.log(`  ✅ Sent to Telegram`);

      // Small delay between Telegram messages
      await new Promise(r => setTimeout(r, 300));
    } catch (error) {
      console.error(`  ❌ Failed to send to Telegram: ${error.message}`);
    }
  }

  // Always save state, even if some sends failed
  saveState(state);
  console.log('\nState saved.');

  console.log('\n' + '='.repeat(50));
  console.log('Tweet Fetcher Complete');
  console.log('='.repeat(50));
}

main().catch(error => {
  console.error('\nFatal error:', error.message);
  process.exit(1);
});
