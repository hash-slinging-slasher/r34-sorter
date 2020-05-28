const fs = require('fs');
const axios = require('axios').default;
const axiosRetry = require('axios-retry');
const cheerio = require('cheerio');
const Promise = require('bluebird');
const BASE_URL = 'https://rule34.xxx';

let outputDir = (() => {
  let d = 'output';
  let i = 1;
  while (fs.existsSync(d)) {
    d = 'output' + i;
    i++;
  }
  return d;
})();
fs.mkdirSync(outputDir);

// Use Exponential Backoff retry strategy
axiosRetry(axios, {
  retries: 4,
  retryDelay: function(retryCount) {
    let randomMs = Math.floor(Math.random() * 1000);
    return Math.pow(2, retryCount) + randomMs
  }
});

// Proper CLI usage
if (process.argv.length < 4) {
  console.error('Usage: node index.js <number of pages to crawl> <tag1> [tag2] ... [tagN]');
  process.exit(1);
}

// Get number of pages to crawl
let pageCount = Number(process.argv[2]);
if (!Number.isInteger(pageCount)) {
  console.error(`${process.argv[2]} is not an integer`);
  process.exit(1);
} else if (pageCount < 1) {
  console.error('Page count should be positive');
  process.exit(1);
}

// Parse tags from CLI
let tags = sanitizeTags(process.argv.slice(3));

(async() => {
  // Request all pages
  console.log('Fetching pages...');
  let pages = await Promise.allSettled(getPages());
  let goodPages = pages.filter(result => result.isFulfilled());
  /**
   * @type {PostMeta[]}
   */
  let posts = goodPages.reduce((acc, result) => acc.concat(result.value()), []);
  // TODO Support for "max number of posts" in CLI
  let topPosts = posts.sort((a, b) => b.score - a.score).slice(0, 100);

  console.log('Fetching top posts...');
  await Promise.allSettled(topPosts.map((p, i) => (
    Promise.resolve(axios(p.href))
      .reflect()
      .then(postResult => {
        if (postResult.isFulfilled()) {
          return fetchImage(postResult.value().data, p, i);
        } else {
          // TOOD Proper error logging/handling here
          console.warn(`[WARN] POST: Failed to fetch ${p.href}`);
          return Promise.resolve();
        }
      })
  ))).each(imageResult => {
    if (imageResult.isRejected()) {
      console.warn(`[WARN] IMAGE: Failed to fetch an image\n${imageResult.reason()}`);
    }
  });

  console.log('Done');
})();

function getPages() {
  let promises = [];

  for (let i = 0; i < pageCount; i++) {
    let pid = i * 42;
    let pageUrl = `${BASE_URL}/index.php?page=post&s=list&pid=${pid}&tags=${tags.join('+')}`;

    let pagePromise = Promise.resolve(axios(pageUrl))
      .reflect()
      .then(result => {
        if (result.isFulfilled()) {
          return parseSearchPage(result.value().data);
        } else {
          // TODO Proper error/logging handling here
          console.warn(`[WARN] PAGE: Failed to fetch ${pageUrl}`);
          return Promise.resolve();
        }
      });

    promises.push(pagePromise);
  }

  return promises;
}

/**
 * Parses a search page and maps all of the results to a simplified object that
 * outlines the each result's link and it's score.
 * @param {string} rawHtml HTML of a search page
 * @returns {PostMeta[]} A list of the simplified objects of each result
 */
function parseSearchPage(rawHtml) {
  let $ = cheerio.load(rawHtml);
  let anchorTags = $('span.thumb > a');
  let imgTags = $('span.thumb > a > img');

  let simplePosts = [];

  // Extract the score and direct link to the post
  for (let i = 0; i < anchorTags.length; i++) {
    // ID can be used to reconstruct link if missing
    let postId = anchorTags[i].attribs.id;
    if (postId == null) {
      console.warn('[WARN] IMAGE: Found a post item without an ID...');
      continue;
    }

    // Post link
    let href = anchorTags[i].attribs.href;
    if (href == null) {
      // Manually reconstruct the link
      // TODO What if there is no post id?
      href = `${BASE_URL}/index.php?page=post&s=view&id=${postId}`
    } else {
      if (href.startsWith('/')) {
        href = href.substring(1);
      }

      href = `${BASE_URL}/${href}`;
    }

    // Parsing score
    let title = imgTags[i].attribs.title;
    let titleSplit = title.split(/\s+/);
    // TODO What if there is no score?
    let scoreString = titleSplit.find(s => s.match(/^score:\d+$/));
    let score = Number(scoreString.split(':')[1]);
    if (Number.isNaN(score)) {
      console.warn('[WARN] IMAG: Post doesn\'t have a score, ignoring it');
      continue;
    }

    simplePosts.push({
      href,
      score
    });
  }

  // Sort posts by their score (in descending order)
  simplePosts.sort((a, b) => b.score - a.score);

  return simplePosts;
}

/**
 * Fetches the image from a post's HTML source.
 * @param {string} rawHtml HTML of a post
 * @param {PostMeta} postMeta some simplified meta data for a post
 * @param {number} index Used for file naming
 * @returns {Promise<void>} A promise that doesn't resolve to anything
 */
async function fetchImage(rawHtml, postMeta, index) {
  let $ = cheerio.load(rawHtml);
  // TODO Support for videos
  let imgTag = $('img#image');
  let imgLink = imgTag[0].attribs.src;

  // Fetch headers of the link to determine content type
  let head = await axios.head(imgLink);
  let ext = head.headers['content-type'].split('/')[1];

  // TODO What if there's a network error when fetching the image?
  // Fetch the image and pipe it to a file
  let postId = /id=(\d+)/.exec(postMeta.href)[1];
  let fileName = `${index}-${postId}.${ext}`;
  let resp = await axios.get(imgLink, {
    responseType: 'stream'
  });
  resp.data.pipe(fs.createWriteStream(`${outputDir}/${fileName}`));
}

/**
 * Parses and sanitizes tags from command line arguments. If a tag has whitespace, then
 * the whitespaces are replaced with underscores. Tags are **NOT** URL encoded.
 *
 * @param {string[]} args Command line arguments
 * @returns {string[]}
 */
function sanitizeTags(args) {
  return args.map(arg => arg.replace(/\s+/gi, '_'));
}

/**
 * @typedef PostMeta
 * @prop {string} href Link to the post
 * @prop {number} score Score of the post
 */
