const express = require("express");
const bodyParser = require("body-parser");
const multer = require("multer");
const fs = require("fs");
const puppeteer = require("puppeteer");



const app = express();
const PORT = 3000;
const JOBS_FILE = "jobsData.json";

// Load jobs from file when the server starts
function loadJobsFromFile() {
    try {
        if (fs.existsSync(JOBS_FILE)) {
            const data = fs.readFileSync(JOBS_FILE, "utf-8");
            return JSON.parse(data);
        }
    } catch (error) {
        console.error("Error loading jobs:", error);
    }
    return [];
}

// Save jobs to file
function saveJobsToFile() {
    try {
        fs.writeFileSync(JOBS_FILE, JSON.stringify(activeJobs, null, 2));
    } catch (error) {
        console.error("Error saving jobs:", error);
    }
}

// Load active jobs when the server starts
let activeJobs = loadJobsFromFile();


app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.json());  // ✅ Ensure JSON requests are parsed
app.use(express.static("public"));
const upload = multer({ dest: "uploads/" });
app.use(express.static("public"));

function parseCookieString(cookieString) {
  return cookieString.split("; ").map((cookie) => {
    const [name, ...valueParts] = cookie.split("=");
    return {
      name,
      value: valueParts.join("="),
      domain: ".facebook.com",
      path: "/",
      httpOnly: false,
      secure: true,
    };
  });
}
// Function to verify if the correct user is logged in
async function getLoggedInUser(page) {
  try {
    await page.goto("https://www.facebook.com/me", {
      waitUntil: "networkidle2",
      timeout: 90000, // Increase timeout to 90 seconds
    });
    const profileName = await page.evaluate(() => {
      const nameElement = document.querySelector("h1, span[id^='profile']");
      return nameElement ? nameElement.innerText : null;
    });
    console.log("Logged in as:", profileName);
    return profileName;
  } catch (error) {
    console.error("Failed to get logged-in user:", error.message);
    return null;
  }
}

async function postCommentOnBehalfOfAccount(account, postUrl, commentText) {
  try {
    console.log(`Posting comment for ${account.username}`);

    const puppeteer = require("puppeteer");

    const browser = await puppeteer.launch({
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium",
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    

    const page = await browser.newPage();
    await page.setCookie(...account.fbCookies);

    // Debug: Verify cookies
    const cookies = await page.cookies();
    console.log("Cookies for user", account.username, cookies);

    const loggedInUser = await getLoggedInUser(page);
    console.log(
      `User logged in: ${loggedInUser} (Expected: ${account.username})`
    );

    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36"
    );

    console.log("Navigating to:", postUrl);
    await page.goto(postUrl, { waitUntil: "networkidle2", timeout: 60000 });

    // Debug: Verify if the correct post page is loaded
    const currentUrl = await page.url();
    const cleanPostUrl = new URL(postUrl);
    cleanPostUrl.search = "";

    const cleanCurrentUrl = new URL(currentUrl);
    cleanCurrentUrl.search = "";

    if (cleanCurrentUrl.href !== cleanPostUrl.href) {
      console.error(
        `Wrong page loaded for ${account.username}. Expected: ${cleanPostUrl.href}, Found: ${cleanCurrentUrl.href}`
      );
      await browser.close();
      return;
    }

    console.log("Page loaded. Scrolling to ensure post is visible...");
    await page.evaluate(() => window.scrollBy(0, 500));
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const commentBoxSelector = "div[contenteditable='true']";
    await page.waitForSelector(commentBoxSelector, { timeout: 100000 });

    console.log("Comment box found. Typing comment...");
    await page.click(commentBoxSelector);
    await page.type(commentBoxSelector, commentText, { delay: 100 });

    await page.keyboard.press("Enter");
    await new Promise((resolve) => setTimeout(resolve, 3000));

    console.log(`Comment posted successfully for ${account.username}`);
    await browser.close();
  } catch (err) {
    console.error(
      `Error posting comment for ${account.username}:`,
      err.message
    );
  }
}


async function startJob(job) {
    job.active = true;
    saveJobsToFile(); // ✅ Save jobs when starting

    let commentIndex = 0;
    let accountIndex = 0;

    while (job.active) {
        if (commentIndex >= job.commentsText.length) commentIndex = 0;
        const commentText = job.commentsText[commentIndex];
        const account = job.fbAccounts[accountIndex];

        console.log(`Posting comment for ${account.username}: ${commentText}`);
        await postCommentOnBehalfOfAccount(account, job.postUrl, commentText);

        accountIndex = (accountIndex + 1) % job.fbAccounts.length;
        commentIndex = (commentIndex + 1) % job.commentsText.length;

        await new Promise((resolve) => setTimeout(resolve, job.interval * 1000));
    }

    console.log(`Job stopped for ${job.postUrl}`);
}



app.post(
    "/start",
    upload.fields([
      { name: "file", maxCount: 1 },
      { name: "commentFile", maxCount: 1 },
    ]),
    async (req, res) => {
      const { postUrl, interval } = req.body;
      const commentFilePath = req.files.commentFile[0].path;
      const cookieFilePath = req.files.file[0].path;
  
      if (!commentFilePath || !cookieFilePath || !interval)
        return res.status(400).send("Files or interval not uploaded properly.");
  
      try {
        const cookieStrings = fs
          .readFileSync(cookieFilePath, "utf-8")
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line);
        const fbAccounts = cookieStrings.map((cookieString, index) => ({
          username: `User${index + 1}`,
          fbCookies: parseCookieString(cookieString),
        }));
  
        const commentsText = fs
          .readFileSync(commentFilePath, "utf-8")
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line);
        fs.unlinkSync(cookieFilePath);
        fs.unlinkSync(commentFilePath);
  
        console.log("Starting auto-commenting...");
        const job = {
          postUrl,
          fbAccounts,
          commentsText,
          interval: parseInt(interval),
          active: true,
        };
        activeJobs.push(job);
        saveJobsToFile(); // ✅ Save jobs to file
  
        startJob(job);
        res.redirect("/");
      } catch (error) {
        res.status(500).send("Error processing files: " + error.message);
      }
    }
  );
  
  app.post("/stop", (req, res) => {
    console.log("Received request to stop job:", req.body);

    const jobIndex = parseInt(req.body.jobIndex);

    if (isNaN(jobIndex) || jobIndex < 0 || jobIndex >= activeJobs.length) {
        return res.status(400).send("Invalid job index.");
    }

    console.log(`Stopping job #${jobIndex + 1}`);

    activeJobs[jobIndex].active = false;
    setTimeout(() => {
        activeJobs.splice(jobIndex, 1);
        saveJobsToFile();  // ✅ Save jobs after stopping
        console.log(`Job ${jobIndex + 1} successfully stopped.`);
    }, 1000);

    res.send(`Stopped commenting for Post ${jobIndex + 1}`);
});




function stopJob(index) {
    console.log("Stopping job index:", index); // Debugging

    fetch('/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobIndex: index }) // ✅ Ensure correct data is sent
    })
    .then(response => response.text())
    .then(message => {
        alert(message);
        location.reload(); // ✅ Refresh the page to update the job list
    })
    .catch(error => console.error("Error stopping job:", error));
}


app.get("/", (req, res) => {
    let activeJobsHtml = activeJobs.map((job, index) => `
    <tr>
        <td>${index + 1}</td>
        <td>Post ${index + 1}</td>
        <td>${job.fbAccounts ? job.fbAccounts.length + " Accounts" : "No Accounts"}</td>
        <td><button class="action-btn" onclick="stopJob(${index})">Stop</button></td>
    </tr>
`).join("");

    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Facebook Auto Commenter</title>
            <link rel="stylesheet" href="./style.css">
        </head>
        <body>
            <div class="container">
                <h2>Facebook Auto Commenter</h2>
                <form action="/start" method="post" enctype="multipart/form-data">
                    <label>Upload Cookie File (TXT - One cookie set per line):</label>
                    <input type="file" name="file" accept=".txt" required>
                    <label>Upload Comments File (TXT - One comment per line):</label>
                    <input type="file" name="commentFile" accept=".txt" required>
                    <label>Post URL:</label>
                    <input type="text" name="postUrl" required>
                    <label>Interval (seconds):</label>
                    <input type="number" name="interval" min="1" required>
                    <button type="submit">Start Commenting</button>
                </form>

                <h3>Active Jobs</h3>
                <div class="table-container">
                <table>
                    <tr>
                        <th>#</th>
                        <th>Post</th>
                        <th>Accounts</th>
                        <th>Actions</th>
                    </tr>
                    ${activeJobsHtml}
                </table>
                </div>
            </div>

            <script>
                function stopJob(index) {
                    fetch('/stop', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ jobIndex: index })
                    }).then(response => response.text())
                    .then(alert)
                    .catch(error => console.error("Error stopping job:", error));
                }
            </script>

        </body>
        </html>
    `);
});


app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
