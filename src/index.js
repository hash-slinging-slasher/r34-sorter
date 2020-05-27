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
    return 2**retryCount + randomMs
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
let tags = parseTags(process.argv.slice(3));

// Request all pages.
// If a page request rejects, then log it.
// If a page request fulfills, then extracting the posts and map them into a score
// and link
let pagePromises = getPages();

Promise.allSettled(pagePromises)
  .filter(result => result.isFulfilled())
  .reduce((simplePosts, currResult) => simplePosts.concat(currResult.value()), [])
  .then(simplePosts => {
    // Sort them again, and take top 100 posts
    /**
     * @type {{href:string, score:number}[]}
     */
    let topPosts = simplePosts.sort((a, b) => b.score - a.score).slice(0, 100);

    Promise.allSettled(topPosts.map((p, i) => (
      Promise.resolve(axios(p.href)).reflect()
        .then(result => {
          if (result.isFulfilled()) {
            getPost(result.value().data, p, i);
          } else {
            // TODO Proper error/logging handling here
            console.warn(`[WARN] POST: ${p.href}`);
          }
        })
    ))).then('Finished');
  });

function getPages() {
  let promises = [];

  for (let i = 0; i < pageCount; i++) {
    let pid = i * 42;
    let pageUrl = `${BASE_URL}/index.php?page=post&s=list&pid=${pid}&tags=${tags.join('+')}`;

    let pagePromise = Promise.resolve(axios(pageUrl))
      .reflect().then(result => {
        if (result.isFulfilled()) {
          return parsePage(result.value().data);
        } else {
          // TODO Proper error/logging handling here
          console.warn(`[WARN] PAGE: ${pageUrl}`);
        }
      });

    promises.push(pagePromise);
  }

  return promises;
}

function parsePage(rawHtml) {
  let $ = cheerio.load(rawHtml);
  let anchorTags = $('span.thumb > a');
  let imgTags = $('span.thumb > a > img');

  let simplePosts = [];

  // Extract the score and direct link to the post
  for (let i = 0; i < anchorTags.length; i++) {
    // ID can be used to reconstruct link if missing
    let postId = anchorTags[i].attribs.id;
    if (postId == null) {
      console.warn('[WARN] IMAG: Found a post item without an ID...');
      continue;
    }

    // Post link
    let href = anchorTags[i].attribs.href;
    if (href == null) {
      // Manually reconstruct the link
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

async function getPost(rawHtml, postMeta, index) {
  let $ = cheerio.load(rawHtml);
  // TODO Support for videos
  let imgTag = $('img#image');
  let imgLink = imgTag[0].attribs.src;

  // Fetch headers of the link to determine content type
  let head = await axios.head(imgLink);
  let ext = head.headers['content-type'].split('/')[1];

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
function parseTags(args) {
  return args.map(arg => arg.replace(/\s+/gi, '_'));
}
