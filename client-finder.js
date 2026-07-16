// client-finder.js
//
// "Client Finding Engine" — the discovery half of the Reddit prospecting idea from
// the spec, WITHOUT the auto-posting half.
//
// Why no auto-posting: Reddit's rules prohibit bots that post the same/similar
// promotional comment across many threads without disclosure — that's textbook
// spam behavior and it's how accounts (and sometimes whole linked domains) get
// banned. Since your Carrd funnel depends on that domain being trusted, an
// auto-poster is a real risk to the business, not just a ToS technicality.
//
// What this does instead:
//   1. On a timer, search Reddit for posts matching your target keywords.
//   2. Skip anything already seen (dedup by Reddit post id in Mongo).
//   3. Optionally draft a *suggested* reply with Gemini — saved as a suggestion,
//      never sent or posted automatically.
//   4. Store each match as a "lead" document with status "pending".
//
// A human (you) reviews GET /leads, edits the suggested reply if you use it,
// and posts it manually and transparently (disclosing you built the tool, per
// Reddit's self-promotion rules) if the thread genuinely looks relevant.
//
// Required env vars:
//   REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, REDDIT_USERNAME, REDDIT_PASSWORD
//     -> a Reddit "script" app (create at reddit.com/prefs/apps)
//   REDDIT_USER_AGENT
//     -> e.g. "leadgen-ai-pro/1.0 by u/yourusername" (Reddit requires a descriptive UA)
// Optional env vars:
//   SEARCH_KEYWORDS          -> comma-separated, default below
//   SEARCH_SUBREDDITS        -> comma-separated subreddit names, default "all"
//   FINDER_INTERVAL_MINUTES  -> default 60
//   FINDER_RESULTS_PER_RUN   -> default 10 (kept small to stay well under rate limits)

const DEFAULT_KEYWORDS = ['cold outreach email', 'cold emailing help', 'linkedin prospecting'];
const DEFAULT_SUBREDDITS = ['all'];

let cachedToken = null;
let cachedTokenExpiry = 0;

// Fetches (and caches) an OAuth access token for Reddit's API using script-app
// credentials. Reddit tokens last ~1 hour; we refresh a little early to be safe.
async function getRedditAccessToken() {
  if (cachedToken && Date.now() < cachedTokenExpiry) {
    return cachedToken;
  }

  const basicAuth = Buffer.from(
    `${process.env.REDDIT_CLIENT_ID}:${process.env.REDDIT_CLIENT_SECRET}`
  ).toString('base64');

  const response = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': process.env.REDDIT_USER_AGENT
    },
    body: new URLSearchParams({
      grant_type: 'password',
      username: process.env.REDDIT_USERNAME,
      password: process.env.REDDIT_PASSWORD
    })
  });

  if (!response.ok) {
    throw new Error(`Reddit auth failed: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  cachedToken = data.access_token;
  // Refresh 60s before actual expiry as a safety margin.
  cachedTokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}

// Searches a single subreddit (or "all") for a single keyword, newest first.
async function searchRedditPosts(keyword, subreddit, limit) {
  const token = await getRedditAccessToken();
  const url = `https://oauth.reddit.com/r/${subreddit}/search?q=${encodeURIComponent(keyword)}&sort=new&restrict_sr=1&limit=${limit}`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      'User-Agent': process.env.REDDIT_USER_AGENT
    }
  });

  if (!response.ok) {
    console.log(`Reddit search failed for "${keyword}" in r/${subreddit}: ${response.status}`);
    return [];
  }

  const data = await response.json();
  return (data?.data?.children || []).map((child) => child.data);
}

// Uses Gemini to draft a *suggested* reply for a human to review/edit before
// posting manually. This is never sent anywhere automatically.
async function draftSuggestedReply(ai, post) {
  try {
    const response = await ai.models.generateContent({
      model: 'gemini-flash-latest',
      contents: `A Reddit post titled "${post.title}" (body: "${(post.selftext || '').slice(0, 500)}") ` +
        `may be relevant to a tool that drafts cold outreach emails. Write a short, genuinely helpful, ` +
        `non-salesy reply (2-4 sentences) that engages with what they actually asked, written as a real ` +
        `person, in Reddit's informal style. Only mention a tool if it's truly relevant to their question, ` +
        `and if you do, note plainly that you built it (per Reddit self-promotion norms). Do not use emojis.`
    });
    return response.text;
  } catch (error) {
    console.log('Reply draft generation failed:', error.message);
    return null;
  }
}

// One full search pass: for every keyword/subreddit combo, find new posts,
// dedupe against what's already stored, draft a suggestion, and save.
async function runSearchPass({ ai, leadsCollection }) {
  const keywords = (process.env.SEARCH_KEYWORDS
    ? process.env.SEARCH_KEYWORDS.split(',').map((k) => k.trim())
    : DEFAULT_KEYWORDS);
  const subreddits = (process.env.SEARCH_SUBREDDITS
    ? process.env.SEARCH_SUBREDDITS.split(',').map((s) => s.trim())
    : DEFAULT_SUBREDDITS);
  const perRun = Number(process.env.FINDER_RESULTS_PER_RUN || 10);

  let newLeadsCount = 0;

  for (const subreddit of subreddits) {
    for (const keyword of keywords) {
      let posts;
      try {
        posts = await searchRedditPosts(keyword, subreddit, perRun);
      } catch (error) {
        console.log(`Reddit search error (${keyword}, r/${subreddit}):`, error.message);
        continue;
      }

      for (const post of posts) {
        const existing = await leadsCollection.findOne({ redditId: post.id });
        if (existing) continue;

        const suggestedReply = await draftSuggestedReply(ai, post);

        await leadsCollection.insertOne({
          redditId: post.id,
          subreddit: post.subreddit,
          title: post.title,
          url: `https://reddit.com${post.permalink}`,
          author: post.author,
          matchedKeyword: keyword,
          createdUtc: post.created_utc,
          suggestedReply,
          status: 'pending',
          foundAt: new Date()
        });
        newLeadsCount += 1;
      }

      // Small delay between calls to stay comfortably within Reddit's rate limits.
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }

  if (newLeadsCount > 0) {
    console.log(`Client finder: queued ${newLeadsCount} new lead(s) for review.`);
  }
}

// Starts the recurring search. Call once after your DB connection is ready.
function startClientFinder({ ai, leadsCollection }) {
  if (!process.env.REDDIT_CLIENT_ID || !process.env.REDDIT_CLIENT_SECRET) {
    console.log('Client finder: Reddit credentials not set, skipping startup.');
    return;
  }

  const intervalMs = Number(process.env.FINDER_INTERVAL_MINUTES || 60) * 60 * 1000;

  // Run once shortly after startup, then on the configured interval.
  setTimeout(() => runSearchPass({ ai, leadsCollection }).catch((e) => console.log('Client finder run failed:', e.message)), 10_000);
  setInterval(() => runSearchPass({ ai, leadsCollection }).catch((e) => console.log('Client finder run failed:', e.message)), intervalMs);

  console.log(`Client finder started (every ${intervalMs / 60000} min).`);
}

// Returns pending leads, newest first, for the /leads endpoint.
async function getPendingLeads(leadsCollection) {
  return await leadsCollection
    .find({ status: 'pending' })
    .sort({ foundAt: -1 })
    .limit(100)
    .toArray();
}

// Marks a lead as dismissed/handled so it stops showing up in /leads.
async function dismissLead(leadsCollection, redditId) {
  await leadsCollection.updateOne({ redditId }, { $set: { status: 'dismissed' } });
}

export { startClientFinder, getPendingLeads, dismissLead };