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
    'RafaelH117',
    'barcauniversal',
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
  
  // Initialize state with null for each account
  const state = { lastUpdate: null };
  CONFIG.ACCOUNTS.forEach(acc => {
    state[acc] = null; // Last seen tweet ID
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
  
  // Handle regular URLs
  if (entities.urls) {
    for (const urlEntity of entities.urls) {
      const shortUrl = urlEntity.url;
      const expandedUrl = urlEntity.expanded_url || urlEntity.display_url || shortUrl;
      
      // Check if it's a media URL (these should be removed from text)
      if (expandedUrl.includes('twitter.com') && expandedUrl.includes('/photo/')) {
        replacements.push({ from: shortUrl, to: '' });
      } else {
        // Regular link - make it clickable
        replacements.push({ from: shortUrl, to: expandedUrl });
      }
    }
  }
  
  // Handle media (images/videos)
  if (entities.media) {
    for (const mediaEntity of entities.media) {
      const shortUrl = mediaEntity.url;
      const mediaUrl = mediaEntity.media_url_https || mediaEntity.media_url;
      
      if (mediaUrl) {
        // Remove t.co link from text, we'll add the direct URL separately
        replacements.push({ from: shortUrl, to: '' });
      }
    }
  }
  
  // Apply replacements
  for (const { from, to } of replacements) {
    expanded = expanded.replace(from, to);
  }
  
  // Clean up extra whitespace
  expanded = expanded.replace(/\s+/g, ' ').trim();
  
  return expanded;
}

function getMediaUrls(entities) {
  const mediaUrls = [];
  
  if (entities && entities.media) {
    for (const mediaEntity of entities.media) {
      const url = mediaEntity.media_url_https || mediaEntity.media_url;
      const type = mediaEntity.type; // 'photo' or 'video'
      
      if (url) {
        mediaUrls.push({ url, type });
      }
    }
  }
  
  return mediaUrls;
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

async function getUserTweets(userId, sinceId = null) {
  const variables = {
    userId: userId,
    count: CONFIG.TWEETS_PER_ACCOUNT,
    includePromotedContent: false,
    withQuickPromoteEligibilityTweetFields: false,
    withVoice: false,
    withV2Timeline: true,
  };
  
  if (sinceId) {
    variables.since_id = sinceId;
  }
  
  // ✅ FIX: Added extended tweet features to prevent truncation
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
      
      // Check for quoted tweet
      let quotedTweet = null;
      if (legacy.quoted_status_result) {
        const quotedLegacy = legacy.quoted_status_result.result?.legacy;
        const quotedUser = legacy.quoted_status_result.result?.core?.user_results?.result?.legacy;
        
        if (quotedLegacy && quotedUser) {
          quotedTweet = {
            text: quotedLegacy.full_text,
            author: quotedUser.screen_name,
            author_name: quotedUser.name,
            entities: quotedLegacy.entities,
          };
        }
      }
      
      return {
        id: legacy.id_str,
        text: legacy.full_text,
        created_at: legacy.created_at,
        retweet_count: legacy.retweet_count || 0,
        favorite_count: legacy.favorite_count || 0,
        reply_count: legacy.reply_count || 0,
        is_retweet: !!legacy.retweeted_status_result,
        entities: legacy.entities,
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
      
      const tweets = await getUserTweets(userId, lastSeenId);
      console.log(`  Found ${tweets.length} new tweet(s)`);
      
      if (tweets.length > 0) {
        // ✅ CRITICAL FIX: Twitter returns tweets NEWEST FIRST
        // So tweets[0] is the NEWEST tweet, which is what we want to save
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
  
  // Expand URLs in main tweet text
  let text = expandUrls(tweet.text, tweet.entities);
  
  // Get media URLs
  const mediaUrls = getMediaUrls(tweet.entities);
  
  // Build message
  let message = `${icon}@${tweet.username} • ${formatted}\n`;
  message += `━━━━━━━━━━━━━━━\n`;
  message += `${text}\n`;
  
  // Add media URLs
  if (mediaUrls.length > 0) {
    message += '\n';
    for (const media of mediaUrls) {
      const emoji = media.type === 'video' ? '🎥' : '📷';
      message += `${emoji} ${media.url}\n`;
    }
  }
  
  // Add quoted tweet if exists
  if (tweet.quoted_tweet) {
    const quotedText = expandUrls(tweet.quoted_tweet.text, tweet.quoted_tweet.entities);
    message += `\n┌─ Quoted tweet ─────────\n`;
    message += `│ @${tweet.quoted_tweet.author}\n`;
    message += `│ ${quotedText.replace(/\n/g, '\n│ ')}\n`;
    message += `└────────────────────────\n`;
  }
  
  // Add stats
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
  
  // Split if too long (Telegram limit: 4096 chars)
  const MAX_LENGTH = 4096;
  const chunks = [];
  
  for (let i = 0; i < message.length; i += MAX_LENGTH) {
    chunks.push(message.substring(i, i + MAX_LENGTH));
  }
  
  for (const chunk of chunks) {
    const body = {
      chat_id: chatId,
      text: chunk,
      disable_web_page_preview: true, // Don't load previews to save data
    };
    
    const result = await httpsPost('api.telegram.org', apiPath, body);
    
    if (!result.ok) {
      throw new Error(`Telegram error: ${JSON.stringify(result)}`);
    }
    
    // Small delay between messages
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
  
  // Load state
  const state = loadState();
  console.log('\nCurrent state:', JSON.stringify(state, null, 2));
  
  // Fetch new tweets
  const newTweets = await fetchAllTweets(state);
  console.log(`\nTotal new tweets: ${newTweets.length}`);
  
  if (newTweets.length === 0) {
    console.log('No new tweets to send');
    saveState(state);
    return;
  }
  
  // Sort chronologically (oldest first) using timestamp parsing
  newTweets.sort((a, b) => {
    const dateA = Date.parse(a.created_at);
    const dateB = Date.parse(b.created_at);
    return dateA - dateB;
  });
  
  // Send to Telegram
  console.log('\nSending to Telegram...');
  for (const tweet of newTweets) {
    const message = formatTweetMessage(tweet);
    
    console.log(`\nSending tweet from @${tweet.username} (${tweet.id})`);
    console.log(`  Posted at: ${tweet.created_at}`);
    
    try {
      await sendToTelegram(message);
      console.log('  ✅ Sent');
      await sleep(1000); // 1 second between tweets
    } catch (error) {
      console.error(`  ❌ Failed: ${error.message}`);
    }
  }
  
  // Save state
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
