/**
 * Twitter Scraper with Replies Support
 * Fetches tweets and their replies via Twitter's GraphQL API
 */

const https = require('https');
const fs = require('fs');

// ════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ════════════════════════════════════════════════════════════════════

const CONFIG = {
  // Accounts to monitor
  ACCOUNTS: [
    'TrueCrypto28',
    'IncomeSharks',
    'RafaelH117',
    'barcauniversal',
  ],
  
  // How many tweets per account
  TWEETS_PER_ACCOUNT: 5,
  
  // How many replies to fetch per tweet (set to 0 to disable)
  REPLIES_PER_TWEET: 0,
  
  // Delay between requests (milliseconds)
  REQUEST_DELAY: 2000,
};

// Twitter's public GraphQL bearer token
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
          reject(new Error(`HTTP ${res.statusCode}`));
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

// ════════════════════════════════════════════════════════════════════
// Twitter API Functions
// ════════════════════════════════════════════════════════════════════

async function getUserId(username) {
  const variables = { screen_name: username, withSafetyModeUserFields: true };
  const features = { hidden_profile_likes_enabled: false };
  
  const url = `https://twitter.com/i/api/graphql/G3KGOASz96M-Qu0nwmGXNg/UserByScreenName` +
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
    responsive_web_enhance_cards_enabled: false
  };
  
  const url = `https://twitter.com/i/api/graphql/V7H0Ap3_Hh2FyS75OCDO3Q/UserTweets` +
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
      
      return {
        id: legacy.id_str,
        text: legacy.full_text,
        created_at: legacy.created_at,
        retweet_count: legacy.retweet_count || 0,
        favorite_count: legacy.favorite_count || 0,
        reply_count: legacy.reply_count || 0,
        is_retweet: !!legacy.retweeted_status_result,
      };
    })
    .filter(Boolean);
}

async function getTweetReplies(tweetId) {
  if (CONFIG.REPLIES_PER_TWEET === 0) return [];
  
  const variables = {
    focalTweetId: tweetId,
    with_rux_injections: false,
    includePromotedContent: false,
    withCommunity: false,
    withQuickPromoteEligibilityTweetFields: false,
    withBirdwatchNotes: false,
    withVoice: false,
  };
  
  const features = {
    rweb_lists_timeline_redesign_enabled: true,
    responsive_web_graphql_exclude_directive_enabled: true,
    verified_phone_label_enabled: false,
    responsive_web_graphql_timeline_navigation_enabled: true,
    view_counts_everywhere_api_enabled: true,
    longform_notetweets_consumption_enabled: true,
    responsive_web_twitter_article_tweet_consumption_enabled: false,
    tweet_awards_web_tipping_enabled: false,
    responsive_web_enhance_cards_enabled: false
  };
  
  const url = `https://twitter.com/i/api/graphql/ItejhtNxjGIbATQVaHnq7g/TweetDetail` +
    `?variables=${encodeURIComponent(JSON.stringify(variables))}` +
    `&features=${encodeURIComponent(JSON.stringify(features))}`;
  
  try {
    const data = await httpsRequest(url, buildHeaders());
    
    const instructions = data.data?.threaded_conversation_with_injections_v2?.instructions || [];
    const entries = instructions.find(i => i.type === 'TimelineAddEntries')?.entries || [];
    
    const replies = [];
    
    for (const entry of entries) {
      // Skip the original tweet and conversational context
      if (!entry.entryId?.startsWith('conversationthread-')) continue;
      
      const items = entry.content?.items || [];
      for (const item of items) {
        const result = item.item?.itemContent?.tweet_results?.result;
        const legacy = result?.legacy || result?.tweet?.legacy;
        const user = result?.core?.user_results?.result?.legacy;
        
        if (!legacy || !user) continue;
        
        // Skip if this is the original tweet
        if (legacy.id_str === tweetId) continue;
        
        replies.push({
          id: legacy.id_str,
          text: legacy.full_text,
          author: user.screen_name,
          author_name: user.name,
          created_at: legacy.created_at,
          favorite_count: legacy.favorite_count || 0,
        });
        
        if (replies.length >= CONFIG.REPLIES_PER_TWEET) break;
      }
      if (replies.length >= CONFIG.REPLIES_PER_TWEET) break;
    }
    
    return replies;
  } catch (error) {
    console.error(`  Failed to fetch replies: ${error.message}`);
    return [];
  }
}

async function fetchAllTweets() {
  const results = [];
  
  for (const username of CONFIG.ACCOUNTS) {
    console.log(`\nFetching @${username}...`);
    
    try {
      const userId = await getUserId(username);
      console.log(`  User ID: ${userId}`);
      await sleep(CONFIG.REQUEST_DELAY);
      
      const tweets = await getUserTweets(userId);
      console.log(`  Found ${tweets.length} tweets`);
      await sleep(CONFIG.REQUEST_DELAY);
      
      // Fetch replies for each tweet
      for (const tweet of tweets) {
        if (CONFIG.REPLIES_PER_TWEET > 0) {
          console.log(`  Fetching replies for tweet ${tweet.id}...`);
          tweet.replies = await getTweetReplies(tweet.id);
          console.log(`    Found ${tweet.replies.length} replies`);
          await sleep(CONFIG.REQUEST_DELAY);
        } else {
          tweet.replies = [];
        }
      }
      
      results.push({ username, tweets });
      
    } catch (error) {
      console.error(`  ❌ Error: ${error.message}`);
      results.push({ username, tweets: [], error: error.message });
    }
  }
  
  return results;
}

// ════════════════════════════════════════════════════════════════════
// HTML Generation
// ════════════════════════════════════════════════════════════════════

function generateHTML(accountData) {
  const now = new Date();
  const lastUpdate = now.toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC'
  }) + ' UTC';
  
  // Flatten all tweets
  const allTweets = [];
  accountData.forEach(({ username, tweets }) => {
    tweets.forEach(tweet => {
      allTweets.push({ ...tweet, username });
    });
  });
  
  // Sort: newest first (Twitter style)
  allTweets.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  
  const tweetHTML = allTweets.map(tweet => {
    const date = new Date(tweet.created_at);
    const formatted = date.toLocaleString('en-GB', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'UTC'
    }) + ' UTC';
    
    const icon = tweet.is_retweet ? '🔁' : '';
    const tweetUrl = `https://twitter.com/${tweet.username}/status/${tweet.id}`;
    
    // Generate replies HTML
    let repliesHTML = '';
    if (tweet.replies && tweet.replies.length > 0) {
      const repliesContent = tweet.replies.map(reply => {
        const replyDate = new Date(reply.created_at);
        const replyFormatted = replyDate.toLocaleString('en-GB', {
          day: '2-digit',
          month: 'short',
          hour: '2-digit',
          minute: '2-digit',
          timeZone: 'UTC'
        }) + ' UTC';
        
        return `
        <div class="reply">
          <div class="reply-header">
            <span class="reply-author">@${escapeHtml(reply.author)}</span>
            <span class="reply-date">${replyFormatted}</span>
          </div>
          <div class="reply-text">${escapeHtml(reply.text)}</div>
          ${reply.favorite_count > 0 ? `<div class="reply-stats">❤️ ${reply.favorite_count}</div>` : ''}
        </div>`;
      }).join('');
      
      repliesHTML = `
      <div class="replies-section">
        <button class="replies-toggle" onclick="toggleReplies(this)">
          <span class="toggle-icon">▶</span>
          Show ${tweet.replies.length} ${tweet.replies.length === 1 ? 'reply' : 'replies'}
        </button>
        <div class="replies-container hidden">
          ${repliesContent}
        </div>
      </div>`;
    }
    
    return `
    <div class="tweet" data-tweet-id="${tweet.id}">
      <div class="tweet-header">
        <div class="tweet-author">
          ${icon ? `<span class="retweet-icon">${icon}</span>` : ''}
          <span class="username">@${tweet.username}</span>
        </div>
        <div class="tweet-date">${formatted}</div>
      </div>
      <div class="tweet-text">${escapeHtml(tweet.text)}</div>
      <div class="tweet-stats">
        ${tweet.reply_count > 0 ? `<span>💬 ${tweet.reply_count}</span>` : ''}
        ${tweet.retweet_count > 0 ? `<span>🔁 ${tweet.retweet_count}</span>` : ''}
        ${tweet.favorite_count > 0 ? `<span>❤️ ${tweet.favorite_count}</span>` : ''}
      </div>
      ${repliesHTML}
      <a href="${tweetUrl}" class="view-link" target="_blank" rel="noopener">View on Twitter →</a>
    </div>`;
  }).join('');
  
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
  <meta name="description" content="Lightweight Twitter feed with replies">
  <meta name="theme-color" content="#15202b">
  <title>Twitter Feed</title>
  <link rel="manifest" href="manifest.json">
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    
    :root {
      --bg-primary: #15202b;
      --bg-secondary: #192734;
      --bg-hover: #1e2732;
      --border-color: #38444d;
      --text-primary: #ffffff;
      --text-secondary: #8899a6;
      --text-link: #1d9bf0;
      --accent: #1d9bf0;
    }
    
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      background: var(--bg-primary);
      color: var(--text-primary);
      line-height: 1.5;
      -webkit-font-smoothing: antialiased;
    }
    
    .container {
      max-width: 600px;
      margin: 0 auto;
      min-height: 100vh;
    }
    
    header {
      position: sticky;
      top: 0;
      background: rgba(21, 32, 43, 0.85);
      backdrop-filter: blur(12px);
      border-bottom: 1px solid var(--border-color);
      padding: 12px 16px;
      z-index: 100;
    }
    
    h1 {
      font-size: 20px;
      font-weight: 800;
      margin-bottom: 2px;
    }
    
    .subtitle {
      font-size: 13px;
      color: var(--text-secondary);
    }
    
    .timeline {
      background: var(--bg-primary);
    }
    
    .tweet {
      border-bottom: 1px solid var(--border-color);
      padding: 12px 16px;
      transition: background-color 0.2s;
      animation: slideIn 0.3s ease-out;
    }
    
    @keyframes slideIn {
      from {
        opacity: 0;
        transform: translateY(-20px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }
    
    .tweet:hover {
      background: var(--bg-hover);
    }
    
    .tweet-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 8px;
    }
    
    .tweet-author {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    
    .retweet-icon {
      font-size: 14px;
    }
    
    .username {
      color: var(--text-primary);
      font-weight: 700;
      font-size: 15px;
    }
    
    .tweet-date {
      color: var(--text-secondary);
      font-size: 13px;
    }
    
    .tweet-text {
      font-size: 15px;
      line-height: 20px;
      margin-bottom: 12px;
      word-wrap: break-word;
      white-space: pre-wrap;
    }
    
    .tweet-stats {
      display: flex;
      gap: 16px;
      margin-bottom: 8px;
      font-size: 13px;
      color: var(--text-secondary);
    }
    
    .tweet-stats span {
      display: flex;
      align-items: center;
      gap: 4px;
    }
    
    .replies-section {
      margin-top: 12px;
      padding-top: 12px;
      border-top: 1px solid var(--border-color);
    }
    
    .replies-toggle {
      background: none;
      border: none;
      color: var(--text-link);
      font-size: 13px;
      font-weight: 700;
      cursor: pointer;
      padding: 8px 0;
      display: flex;
      align-items: center;
      gap: 6px;
      transition: color 0.2s;
    }
    
    .replies-toggle:hover {
      color: #1a8cd8;
    }
    
    .toggle-icon {
      transition: transform 0.2s;
      font-size: 10px;
    }
    
    .replies-toggle.expanded .toggle-icon {
      transform: rotate(90deg);
    }
    
    .replies-container {
      margin-top: 8px;
      padding-left: 12px;
      border-left: 2px solid var(--border-color);
    }
    
    .replies-container.hidden {
      display: none;
    }
    
    .reply {
      padding: 8px 0;
      border-bottom: 1px solid var(--bg-hover);
    }
    
    .reply:last-child {
      border-bottom: none;
    }
    
    .reply-header {
      display: flex;
      justify-content: space-between;
      margin-bottom: 4px;
    }
    
    .reply-author {
      color: var(--text-primary);
      font-weight: 600;
      font-size: 14px;
    }
    
    .reply-date {
      color: var(--text-secondary);
      font-size: 12px;
    }
    
    .reply-text {
      font-size: 14px;
      line-height: 18px;
      color: var(--text-primary);
      margin-bottom: 4px;
    }
    
    .reply-stats {
      font-size: 12px;
      color: var(--text-secondary);
    }
    
    .view-link {
      color: var(--text-link);
      text-decoration: none;
      font-size: 13px;
      display: inline-block;
      margin-top: 8px;
      font-weight: 400;
    }
    
    .view-link:hover {
      text-decoration: underline;
    }
    
    footer {
      text-align: center;
      padding: 24px 16px;
      color: var(--text-secondary);
      font-size: 13px;
      border-top: 1px solid var(--border-color);
    }
    
    .refresh-btn {
      position: fixed;
      bottom: 20px;
      right: 20px;
      background: var(--accent);
      color: white;
      border: none;
      border-radius: 50%;
      width: 56px;
      height: 56px;
      font-size: 24px;
      box-shadow: 0 4px 12px rgba(29, 155, 240, 0.4);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 99;
      transition: transform 0.2s, box-shadow 0.2s;
    }
    
    .refresh-btn:hover {
      transform: scale(1.05);
      box-shadow: 0 6px 16px rgba(29, 155, 240, 0.6);
    }
    
    .refresh-btn:active {
      transform: scale(0.95);
    }
    
    .refresh-btn.spinning {
      animation: spin 1s linear infinite;
    }
    
    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
    
    .empty-state {
      text-align: center;
      padding: 60px 20px;
      color: var(--text-secondary);
    }
    
    @media (max-width: 600px) {
      .container {
        padding: 0;
      }
      
      header {
        padding: 10px 12px;
      }
      
      .tweet {
        padding: 10px 12px;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>Home</h1>
      <div class="subtitle">Updated ${lastUpdate}</div>
    </header>
    
    <main class="timeline">
      ${tweetHTML || '<div class="empty-state"><p>No tweets found</p></div>'}
    </main>
    
    <footer>
      Auto-updates every 30 minutes<br>
      Monitoring: ${CONFIG.ACCOUNTS.map(u => '@' + u).join(', ')}
    </footer>
  </div>
  
  <button class="refresh-btn" onclick="refreshPage()" title="Refresh" aria-label="Refresh">
    ↻
  </button>
  
  <script>
    // Register service worker
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
    
    // Toggle replies visibility
    function toggleReplies(button) {
      button.classList.toggle('expanded');
      const container = button.nextElementSibling;
      container.classList.toggle('hidden');
      
      if (container.classList.contains('hidden')) {
        button.innerHTML = '<span class="toggle-icon">▶</span> Show ' + 
          container.querySelectorAll('.reply').length + ' ' +
          (container.querySelectorAll('.reply').length === 1 ? 'reply' : 'replies');
      } else {
        button.innerHTML = '<span class="toggle-icon">▶</span> Hide replies';
      }
    }
    
    // Refresh page with animation
    function refreshPage() {
      const btn = document.querySelector('.refresh-btn');
      btn.classList.add('spinning');
      location.reload();
    }
    
    // Auto-refresh every 30 minutes
    setTimeout(() => location.reload(), 30 * 60 * 1000);
    
    // Scroll restoration
    if ('scrollRestoration' in history) {
      history.scrollRestoration = 'manual';
    }
    window.scrollTo(0, 0);
  </script>
</body>
</html>`;
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ════════════════════════════════════════════════════════════════════
// Main
// ════════════════════════════════════════════════════════════════════

async function main() {
  console.log('═'.repeat(60));
  console.log('Twitter Scraper with Replies');
  console.log(`Time: ${new Date().toISOString()}`);
  console.log(`Accounts: ${CONFIG.ACCOUNTS.join(', ')}`);
  console.log(`Replies per tweet: ${CONFIG.REPLIES_PER_TWEET}`);
  console.log('═'.repeat(60));
  
  const accountData = await fetchAllTweets();
  
  const html = generateHTML(accountData);
  fs.writeFileSync('index.html', html, 'utf8');
  console.log('\n✅ Generated index.html');
  
  const totalTweets = accountData.reduce((sum, a) => sum + a.tweets.length, 0);
  const totalReplies = accountData.reduce((sum, a) => 
    sum + a.tweets.reduce((s, t) => s + (t.replies?.length || 0), 0), 0);
  
  console.log(`📊 Total tweets: ${totalTweets}`);
  console.log(`💬 Total replies: ${totalReplies}`);
  
  console.log('\n' + '═'.repeat(60));
  console.log('Complete');
  console.log('═'.repeat(60));
}

main().catch(error => {
  console.error('\n❌ Fatal error:', error.message);
  process.exit(1);
});
