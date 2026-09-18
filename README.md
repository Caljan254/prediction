# Betika Analyst Hub

An advanced, single-page web application (HTML5, CSS3, Vanilla JavaScript, Chart.js) that aggregates football match predictions from multiple sources (Forebet, APWin, SportyTrader, OddsPortal, X/Twitter, Reddit), tracks prediction accuracy over time, builds accumulator tickets, and **automatically checks live and final match results** to mark predictions and tickets as **Won** or **Lost** in real time.

---

## 🚀 Key Features

1. **Admin Login & Route Protection**
   - Hardcoded admin authentication credentials:
     - **Username:** `Admin`
     - **Password:** `Admin@123_`
   - Session stored in `localStorage` under `bah_session`.
   - Logout button in the header; unauthenticated visits are blocked with an overlay.

2. **Real Betika Daily Games & Live Predictive Feed**
   - Directly integrated with Betika's live match API (`https://api.betika.com/v1/uo/matches?tab=today&sport_id=14`).
   - Fetches and predicts today's real games featured on Betika daily (e.g. Leeds vs Newcastle, Villarreal vs Betis, Torino vs AS Roma, Inter Milan vs Udinese, Bodø/Glimt vs Sandefjord, Gaziantep vs Fenerbahçe, Braga vs Estoril, etc.).
   - Authentic Betika 1X2 odds, kick-off times, and multi-source predictions (Forebet AI, APWin Sharp Index, SportyTrader, OddsPortal, Twitter, and Reddit consensus).
   - "Sync Betika Matches" button in the header and settings for on-demand live refreshing.
   - Live table with columns: `Time`, `League`, `Home Team`, `Away Team`, `Prediction`, `Confidence` (color-coded), `Sources`, `Odds`, `Status` (Won/Lost/Pending), and `Result` (actual score).
   - Filter by status (`Pending`, `Won`, `Lost`) and by competition league.
   - **Match Analysis Modal**:
     - Head-to-Head (H2H) breakdown (last 20 games)
     - Recent Form (last 5 games: W/D/L color pills)
     - Squad & Absences (injuries, suspensions)
     - Travel, pitch, and rest days
     - Social Sentiment bar & quotes (X/Twitter and Reddit)
     - Individual analyst consensus log

3. **Prediction Sources Consensus Panel**
   - Form to log picks from Forebet, APWin, SportyTrader, OddsPortal, X/Twitter, Reddit discussions, or Custom sources.
   - Stores source name, match reference, prediction, confidence level, timestamp, and tactical notes.

4. **Live In-Play Scoring & Automatic Result Verification Engine**
   - **Three-State Match Lifecycle**:
     - 🟡 **Pending (Unplayed):** When games have not yet kicked off, they remain strictly **Pending** with result showing `—` (Awaiting kickoff). No predictions are prematurely marked Won or Lost.
     - 🔴 **LIVE (In-Play):** As matches kick off, they transition to **LIVE** with a glowing live badge (e.g. `LIVE 34'`, `LIVE HT`, `LIVE 72'`) and display the current live running score (e.g. `1-0 (34')`).
     - 🟢/🔴 **Won or Lost (Full Time):** Once the match concludes (**FT**), the engine evaluates the prediction against the final score, marks the game **Won** or **Lost**, and records the final score (e.g. `2-1 FT`).
   - Background polling every 5 minutes (with countdown timer in header).
   - On-demand **"Check Results"** button in header.
   - Evaluates multi-market predictions automatically against final scores:
     - `Home Win` (1), `Draw` (X), `Away Win` (2)
     - `1X` (Home or Draw), `X2` (Draw or Away), `12` (Home or Away)
     - `Over 2.5`, `Under 2.5`, `Over 1.5`, `Under 1.5`, `Over 3.5`, `Under 3.5`
     - `BTTS` (Both Teams to Score - Yes) and `BTTS No`
   - Toast notification reporting format:
     > *"3 predictions auto-checked. 2 won, 1 lost."*
   - Caching layer (`bah_api_cache`) preserves API responses for 10 minutes to prevent rate limits.
   - **Fallback & Testing Simulators:**
     - **"Simulate Live Kick-off (In-Play)":** Puts fixtures into live in-play state with dynamic running scores.
     - **"Simulate Final Whistle (FT)":** Concludes live games with final scores and auto-evaluates predictions.
     - **Manual JSON Paste:** Textarea in API Settings to bypass CORS restrictions when copying raw Apify/Flashscore data.

5. **Accumulator Ticket Builder**
   - Multi-select matches from active fixtures into a betting slip.
   - Automatically calculates combined compound odds.
   - Computes potential KES returns based on stake input.
   - Estimates historical accumulator hit rate.
   - Saved accumulator tickets automatically update to **Won** (if all legs win) or **Lost** (if any leg fails) as games conclude.

6. **Results Tracker Dashboard (Chart.js)**
   - Top KPI cards: Lifetime Predictions, Won count, Lost count, Pending count, and Overall Hit Rate (%).
   - Dynamic charts:
     - Outcome distribution donut chart
     - Accuracy by Source platform (%)
     - Accuracy by Confidence level (%)
     - Accuracy by League / Competition (%)

7. **Zero-Backend LocalStorage Persistence**
   - Uses strict storage keys:
     - `bah_session`: session state
     - `bah_predictions`: fixture predictions array
     - `bah_results`: final scores
     - `bah_tickets`: accumulator slips
     - `bah_sources`: analyst log
     - `bah_api_cache`: 10-minute cache with timestamp
     - `bah_apify_token`: Apify personal token
   - **Export Data**: Downloads complete state as a formatted JSON file.
   - **Import Data**: Restores state from any exported JSON backup.
   - **Load Fresh Demo Dataset**: Resets to rich starter fixtures at any time.

8. **Permanent Disclaimer Banner**
   - *"This tool tracks prediction accuracy. It does NOT guarantee wins. All betting carries risk. Past accuracy does not predict future results."*

---

## 🔑 How to Get a Free Apify API Token

Apify offers a generous **free tier with $5 monthly credit** (enough for ~50,000 scraping runs per month).

1. Go to [https://apify.com](https://apify.com) and click **Sign Up** (or login with Google / GitHub).
2. Once signed in, navigate to **Settings** > **Integrations** or open:
   [https://console.apify.com/account/integrations](https://console.apify.com/account/integrations)
3. Under **API Tokens**, find your **Personal API token** (or click *Add token*).
4. Copy the token string (it starts with `apify_api_...`).
5. Open **Betika Analyst Hub** in your browser, go to the **API & Data** tab, paste your token into the **Apify Personal API Token** field, and click **Save Token**.
6. Click **Test API Connection** to verify connection to Apify.

---

## ⚙️ How the Auto-Check Feature Works

The Hub supports two primary scraper actors on Apify:

1. **Flashscore Live Matches (Default)**
   - Actor ID: `khadinakbar/flashscore-live-matches`
   - Input: `{ "sport": "football", "dayOffsets": [0], "statuses": ["live", "finished"] }`
   - Yields live scores, minutes, and final FT scores.

2. **ESPN Scraper (Alternative)**
   - Actor ID: `crawlerbros/espn-scraper`
   - Input: `{ "mode": "scoreboard", "sport": "soccer", "league": "eng.1" }`
   - Free alternative covering top European leagues.

### Background Polling Workflow
1. Every **5 minutes**, the background timer fires `checkLiveResults()`.
2. Matches with `Status: Pending` are matched against the scraper dataset using fuzzy team name matching.
3. When a match has concluded (`status: finished` / `FT`), its final score is extracted.
4. The prediction outcome rule is evaluated:
   - If the rule holds, `Status` is marked **Won**.
   - If the rule fails, `Status` is marked **Lost**.
   - The final score is recorded in the `Result` column.
5. Tickets containing this fixture update their leg progress. If all legs are Won, the ticket becomes **Won**; if any leg fails, the ticket becomes **Lost**.
6. All changes persist to `localStorage` immediately.

### CORS & Network Fallback Options
Because this is a pure front-end static application:
- **Direct Apify REST Calls:** If permitted by your network and browser CORS, direct fetch runs automatically.
- **Manual JSON Paste:** In the **API & Data** tab, you can paste the JSON response directly into the textarea and click **Process Manual JSON**.
- **Instant Simulator:** For instant testing without waiting for live fixtures to conclude, click **"Simulate All Pending Games"** to simulate realistic scores and see auto-evaluation in action!

---

## 📦 How to Run or Deploy

### Option 1: Run Locally
Simply double-click `index.html` or open it in any modern browser (Chrome, Edge, Firefox, Safari).

To run with a local web server (recommended):
```bash
# Using Python
python -m http.server 8000

# Or using Node npx
npx serve .
```
Then visit `http://localhost:8000` in your browser.

### Option 2: Deploy to GitHub Pages
1. Push `index.html`, `style.css`, and `app.js` to a GitHub repository.
2. In the repository settings, navigate to **Pages**.
3. Select the `main` branch and `/ (root)` folder, then save.
4. Your site will be live instantly!

### Option 3: Deploy to Vercel or Netlify
- **Netlify:** Drag and drop the folder containing `index.html`, `style.css`, and `app.js` onto [netlify.com/drop](https://app.netlify.com/drop).
- **Vercel:** Import your GitHub repo or run `npx vercel` in the project directory.

---

## 🎨 Design & Theme
- **Dark Theme:** Deep obsidian background (`#0a0e17`) with glassmorphism card surfaces (`#121927`).
- **Betika Sports Green Accents:** `#00E676` and `#00C853`.
- **Status Indicators:**
  - 🟢 **Won:** `#00E676` (Glowing emerald)
  - 🔴 **Lost:** `#EF4444` (Vibrant crimson)
  - 🟡 **Pending:** `#F59E0B` (Warm amber)
- **Monospace Typography:** `JetBrains Mono` for odds, scores, and currency figures.
