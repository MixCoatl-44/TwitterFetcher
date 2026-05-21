/**
 * Twitter to Telegram Scraper
 * Fetches tweets and sends them to Telegram with expanded URLs
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// ════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ════════════════════════════════════════════════════════════════════

const CONFIG = {
  ACCOUNTS: [
    'IncomeSharks',
    'DominicWaghorn',
    'TruthTrumpPosts',
    'barcauniversal',
    'spectatorindex',
    'RafaelH117',
    'tparsi',
    'TheStudyofWar',
    'sentdefender',
    'rich_goldberg',
    'netblocks',
    'FabrizioRomano',
    'TrueCrypto',
    'sdfprop',
    'nebraskangooner',
  ],
  
  TWEETS_PER_ACCOUNT: 44,
  REQUEST_DELAY: 2000,
  STATE_FILE: path.join(__dirname, '../data/state.json'),
};

// Updated GraphQL query IDs (May 2026)
const GRAPHQL_IDS = {
  UserByScreenName: '32pL5BWe9WKeSK1MoPvFQQ',
  UserTweets: 'Y9WM4Id6UcGFE8Z-hbnixw',
  TweetDetail: 'Ez6kRPyXbqNlhBwcNMpU-Q',
};

const TWITTER_BEARER = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

// ════════════════════════════════════════════════════════════════════
// Utilities
// ════════════════════════════════════════════════════════════════════

function httpsRequest(url, headers) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 429) {
          reject(new Error('RATE_LIMITED'));
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error('Invalid JSON'));
        }
      });
    }).on('error', reject);
  });
}

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
      },
    };
    
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error('Invalid Telegram response'));
        }
      });
    });
    
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

function buildHeaders() {
  const authToken = process.env.TWITTER_AUTH_TOKEN;
  const ct0 = process.env.TWITTER_CT0;
  
  if (!authToken || !ct0) {
    throw new Error('Missing TWITTER_AUTH_TOKEN or TWITTER_CT0');
  }
  
  return {
    'authorization': `Bearer ${TWITTER_BEARER}`,
    'cookie': `auth_token=${authToken}; ct0=${ct0}`,
    'x-csrf-token': ct0,
    'x-twitter-active-user': 'yes',
    'x-twitter-client-language': 'en',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  };
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function loadState() {
  try {
    if (fs.existsSync(CONFIG.STATE_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG.STATE_FILE, 'utf8'));
    }
  } catch (error) {
    console.warn('Failed to load state:', error.message);
  }
  
  const state = { lastUpdate: null };
  CONFIG.ACCOUNTS.forEach(acc => {
    state[acc] = null;
  });
  return state;
}

function saveState(state) {
  const dir = path.dirname(CONFIG.STATE_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  
  state.lastUpdate = new Date().toISOString();
  fs.writeFileSync(CONFIG.STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

// ════════════════════════════════════════════════════════════════════
// URL Expansion
// ════════════════════════════════════════════════════════════════════

function expandUrls(text, entities) {
  if (!entities) return text;
  
  let expanded = text;
  const replacements = [];
  
  if (entities.urls) {
    for (const urlEntity of entities.urls) {
      const shortUrl = urlEntity.url;
      const expandedUrl = urlEntity.expanded_url || urlEntity.display_url || shortUrl;
      
      if (expandedUrl.includes('twitter.com') && expandedUrl.includes('/photo/')) {
        replacements.push({ from: shortUrl, to: '' });
      } else {
        replacements.push({ from: shortUrl, to: expandedUrl });
      }
    }
  }
  
  if (entities.media) {
    for (const mediaEntity of entities.media) {
      const shortUrl = mediaEntity.url;
      const mediaUrl = mediaEntity.media_url_https || mediaEntity.media_url;
      
      if (mediaUrl) {
        replacements.push({ from: shortUrl, to: '' });
      }
    }
  }
  
  for (const { from, to } of replacements) {
    expanded = expanded.replace(from, to);
  }
  
  expanded = expanded.replace(/\s+/g, ' ').trim();
  
  return expanded;
}

function getMediaUrls(entities) {
  const mediaUrls = [];
  
  if (entities && entities.media) {
    for (const mediaEntity of entities.media) {
      const url = mediaEntity.media_url_https || mediaEntity.media_url;
      const type = mediaEntity.type;
      
      if (url) {
        mediaUrls.push({ url, type });
      }
    }
  }
  
  return mediaUrls;
}

// ════════════════════════════════════════════════════════════════════
// Full text extraction (handles long tweets)
// ════════════════════════════════════════════════════════════════════

function getFullText(legacy, result) {
  const noteText = result?.note_tweet?.note_tweet_results?.result?.text;
  if (noteText) return noteText;
  return legacy.full_text || '';
}

// ════════════════════════════════════════════════════════════════════
// Quoted tweet extraction (shared helper)
// ════════════════════════════════════════════════════════════════════

/**
 * Extracts a quoted tweet from a result object.
 * parentResult is used as a fallback user source for self-quotes,
 * where the API omits user info inside the quoted_status_result.
 */
function extractQuotedTweet(sourceResult, parentResult) {
  if (!sourceResult?.quoted_status_result) return null;

  const quotedResult = sourceResult.quoted_status_result.result;
  const quotedLegacy = quotedResult?.legacy;
  if (!quotedLegacy) return null;

  // ── FIX 1: self-quotes ───────────────────────────────────────────
  // The API sometimes omits user info for self-quotes. Fall back to
  // the parent tweet's author in that case.
  const quotedUser =
    quotedResult?.core?.user_results?.result?.legacy ||
    parentResult?.core?.user_results?.result?.legacy;

  if (!quotedUser) return null;

  return {
    text: getFullText(quotedLegacy, quotedResult),
    author: quotedUser.screen_name,
    author_name: quotedUser.name,
    entities: quotedLegacy.entities,
  };
}

// ════════════════════════════════════════════════════════════════════
// Twitter API
// ════════════════════════════════════════════════════════════════════

async function getUserId(username) {
  const variables = { screen_name: username, withSafetyModeUserFields: true };
  const features = { hidden_profile_likes_enabled: false };
  
  const url = `https://twitter.com/i/api/graphql/${GRAPHQL_IDS.UserByScreenName}/UserByScreenName` +
    `?variables=${encodeURIComponent(JSON.stringify(variables))}` +
    `&features=${encodeURIComponent(JSON.stringify(features))}`;
  
  const data = await httpsRequest(url, buildHeaders());
  return data.data?.user?.result?.rest_id;
}

async function getUserTweets(userId) {
  const variables = {
    userId: userId,
    count: CONFIG.TWEETS_PER_ACCOUNT,
    includePromotedContent: false,
    withQuickPromoteEligibilityTweetFields: false,
    withVoice: false,
    withV2Timeline: true,
  };
  
  const features = {
    rweb_lists_timeline_redesign_enabled: true,
    responsive_web_graphql_exclude_directive_enabled: true,
    verified_phone_label_enabled: false,
    responsive_web_graphql_timeline_navigation_enabled: true,
    view_counts_everywhere_api_enabled: true,
    longform_notetweets_consumption_enabled: true,
    tweet_awards_web_tipping_enabled: false,
    responsive_web_enhance_cards_enabled: false,
    creator_subscriptions_tweet_preview_api_enabled: true,
    tweetypie_unmention_optimization_enabled: true,
    responsive_web_edit_tweet_api_enabled: true,
    graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
    longform_notetweets_rich_text_read_enabled: true,
    longform_notetweets_inline_media_enabled: true,
    responsive_web_media_download_video_enabled: false,
    tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
    vibe_api_enabled: true,
  };
  
  const url = `https://twitter.com/i/api/graphql/${GRAPHQL_IDS.UserTweets}/UserTweets` +
    `?variables=${encodeURIComponent(JSON.stringify(variables))}` +
    `&features=${encodeURIComponent(JSON.stringify(features))}`;
  
  const data = await httpsRequest(url, buildHeaders());
  
  const instructions = data.data?.user?.result?.timeline_v2?.timeline?.instructions || [];
  const entries = instructions.find(i => i.type === 'TimelineAddEntries')?.entries || [];
  
  return entries
    .filter(e => e.content?.entryType === 'TimelineTimelineItem')
    .map(e => {
      const result = e.content?.itemContent?.tweet_results?.result;
      const legacy = result?.legacy || result?.tweet?.legacy;
      
      if (!legacy) return null;
      
      const fullText = getFullText(legacy, result);

      // ── Retweets: pull full text from the original tweet ─────────
      let isRetweet = !!legacy.retweeted_status_result;
      let finalText = fullText;
      let finalEntities = legacy.entities;
      let rtResult = null;

      if (isRetweet) {
        rtResult = legacy.retweeted_status_result?.result;
        const rtLegacy = rtResult?.legacy || rtResult?.tweet?.legacy;
        if (rtLegacy) {
          finalText = getFullText(rtLegacy, rtResult);
          finalEntities = rtLegacy.entities;
        }
      }

      // ── FIX 2: quoted tweet — check the right level ──────────────
      // For a plain quote tweet:     quoted_status_result is on result
      // For a retweet of a quote:    quoted_status_result is on rtResult
      // extractQuotedTweet() also handles self-quotes (Fix 1).
      const quotedTweet = isRetweet
        ? extractQuotedTweet(rtResult, rtResult)
        : extractQuotedTweet(result, result);
      
      return {
        id: legacy.id_str,
        text: finalText,
        created_at: legacy.created_at,
        retweet_count: legacy.retweet_count || 0,
        favorite_count: legacy.favorite_count || 0,
        reply_count: legacy.reply_count || 0,
        is_retweet: isRetweet,
        entities: finalEntities,
        quoted_tweet: quotedTweet,
      };
    })
    .filter(Boolean);
}

async function fetchAllTweets(state) {
  const allNewTweets = [];
  
  for (const username of CONFIG.ACCOUNTS) {
    console.log(`\nFetching @${username}...`);
    
    try {
      const userId = await getUserId(username);
      console.log(`  User ID: ${userId}`);
      await sleep(CONFIG.REQUEST_DELAY);
      
      const lastSeenId = state[username];
      console.log(`  Last seen ID: ${lastSeenId || 'none (first run)'}`);
      
      let tweets = await getUserTweets(userId);
      console.log(`  Fetched ${tweets.length} recent tweet(s)`);
      
      if (lastSeenId) {
        tweets = tweets.filter(tweet => tweet.id > lastSeenId);
        console.log(`  After filtering: ${tweets.length} truly new tweet(s)`);
      }
      
      if (tweets.length > 0) {
        state[username] = tweets[0].id;
        console.log(`  Updated last seen ID to: ${state[username]}`);
        
        for (const tweet of tweets) {
          allNewTweets.push({ ...tweet, username });
        }
      }
      
      await sleep(CONFIG.REQUEST_DELAY);
      
    } catch (error) {
      console.error(`  ❌ Error: ${error.message}`);
    }
  }
  
  return allNewTweets;
}

// ════════════════════════════════════════════════════════════════════
// Telegram
// ════════════════════════════════════════════════════════════════════

function formatTweetMessage(tweet) {
  const date = new Date(tweet.created_at);
  const formatted = date.toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC'
  }) + ' UTC';
  
  const icon = tweet.is_retweet ? '🔁 ' : '';
  const tweetUrl = `https://twitter.com/${tweet.username}/status/${tweet.id}`;
  
  let text = expandUrls(tweet.text, tweet.entities);
  const mediaUrls = getMediaUrls(tweet.entities);
  
  let message = `${icon}@${tweet.username} • ${formatted}\n`;
  message += `━━━━━━━━━━━━━━━\n`;
  message += `${text}\n`;
  
  if (mediaUrls.length > 0) {
    message += '\n';
    for (const media of mediaUrls) {
      const emoji = media.type === 'video' ? '🎥' : '📷';
      message += `${emoji} ${media.url}\n`;
    }
  }
  
  if (tweet.quoted_tweet) {
    const quotedText = expandUrls(tweet.quoted_tweet.text, tweet.quoted_tweet.entities);
    message += `\n┌─ Quoted tweet ─────────\n`;
    message += `│ @${tweet.quoted_tweet.author}\n`;
    message += `│ ${quotedText.replace(/\n/g, '\n│ ')}\n`;
    message += `└────────────────────────\n`;
  }
  
  const stats = [];
  if (tweet.reply_count > 0) stats.push(`💬 ${formatNumber(tweet.reply_count)}`);
  if (tweet.retweet_count > 0) stats.push(`🔁 ${formatNumber(tweet.retweet_count)}`);
  if (tweet.favorite_count > 0) stats.push(`❤️ ${formatNumber(tweet.favorite_count)}`);
  
  if (stats.length > 0) {
    message += `\n${stats.join('  ')}\n`;
  }
  
  message += `\n🔗 ${tweetUrl}`;
  
  return message;
}

function formatNumber(num) {
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
  return num.toString();
}

async function sendToTelegram(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  
  if (!token || !chatId) {
    throw new Error('Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID');
  }
  
  const apiPath = `/bot${token}/sendMessage`;
  const MAX_LENGTH = 4096;
  const chunks = [];
  
  for (let i = 0; i < message.length; i += MAX_LENGTH) {
    chunks.push(message.substring(i, i + MAX_LENGTH));
  }
  
  for (const chunk of chunks) {
    const body = {
      chat_id: chatId,
      text: chunk,
      disable_web_page_preview: true,
    };
    
    const result = await httpsPost('api.telegram.org', apiPath, body);
    
    if (!result.ok) {
      throw new Error(`Telegram error: ${JSON.stringify(result)}`);
    }
    
    if (chunks.length > 1) {
      await sleep(500);
    }
  }
}

// ════════════════════════════════════════════════════════════════════
// Main
// ════════════════════════════════════════════════════════════════════

async function main() {
  console.log('═'.repeat(60));
  console.log('Twitter to Telegram Scraper');
  console.log(`Time: ${new Date().toISOString()}`);
  console.log(`Accounts: ${CONFIG.ACCOUNTS.join(', ')}`);
  console.log('═'.repeat(60));
  
  const state = loadState();
  console.log('\nCurrent state:', JSON.stringify(state, null, 2));
  
  const newTweets = await fetchAllTweets(state);
  console.log(`\nTotal new tweets: ${newTweets.length}`);
  
  if (newTweets.length === 0) {
    console.log('No new tweets to send');
    saveState(state);
    return;
  }
  
  newTweets.sort((a, b) => {
    const dateA = Date.parse(a.created_at);
    const dateB = Date.parse(b.created_at);
    return dateA - dateB;
  });
  
  console.log('\nSending to Telegram...');
  for (const tweet of newTweets) {
    const message = formatTweetMessage(tweet);
    
    console.log(`\nSending tweet from @${tweet.username} (${tweet.id})`);
    console.log(`  Posted at: ${tweet.created_at}`);
    
    try {
      await sendToTelegram(message);
      console.log('  ✅ Sent');
      await sleep(1000);
    } catch (error) {
      console.error(`  ❌ Failed: ${error.message}`);
    }
  }
  
  saveState(state);
  console.log('\n✅ State saved');
  
  console.log('\n' + '═'.repeat(60));
  console.log('Complete');
  console.log('═'.repeat(60));
}

main().catch(error => {
  console.error('\n❌ Fatal error:', error.message);
  console.error(error.stack);
  process.exit(1);
});
