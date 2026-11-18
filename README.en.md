# Cisco UCCX 12.5 & 15 Real-Time Wallboard Dashboard

🇬🇧 **English** | 🇹🇷 [Türkçe (README.md)](README.md)

This project is a modern, TV- and NOC-friendly real-time Wallboard application that reads live queue (CSQ) and agent statistics from **Cisco Unified Contact Center Express (UCCX) 12.5 and 15** systems.

---

## 📋 Table of Contents
1. [Architecture and How It Works](#1-architecture-and-how-it-works)
2. [UCCX 12.5 and 15 Database Schema and Column Mapping](#2-uccx-125-and-15-database-schema-and-column-mapping)
3. [Required UCCX Server Pre-Configuration](#3-required-uccx-server-pre-configuration)
4. [Deploying with Docker Compose](#4-deploying-with-docker-compose)
5. [Running in a Local Development Environment](#5-running-in-a-local-development-environment)
6. [Environment Variables](#6-environment-variables)
7. [User Interface Features](#7-user-interface-features)

---

## 1. Architecture and How It Works

* **Database Engine:** IBM Informix Dynamic Server (IDS) - `db_cra`
* **Connection Protocol:** Informix SQLI (`onsoctcp`) - Port `1504`
* **Driver:** IBM Informix JDBC Driver (`ifxjdbc.jar`)
* **Backend:** Node.js (Express + WebSocket `ws`)
* **Frontend:** Lightweight HTML5/CSS3/Vanilla JS responsive for large TV screens (automatic WebSocket push every 10 seconds).
* **Themes:** Sunny (beige/gold), Dark TV (OLED black), Cisco Navy (corporate blue), and Slate Gray.

---

## 2. UCCX 12.5 and 15 Database Schema and Column Mapping

Per the [Cisco UCCX Database Schema Guide](https://www.cisco.com/c/en/us/td/docs/voice_ip_comm/cust_contact/contact_center/crs/express_12_5/reference/guide/uccx_b_125db-schema-guide/uccx_b_125db-schema-guide_chapter_01.html), real-time wallboard metrics are queried from **`RtCSQsSummary`** (Per-CSQ) and **`RtICDStatistics`** (System Overall):

| Dashboard Card | Informix Column (`RtCSQsSummary`) | Type / Format | Description |
| :--- | :--- | :--- | :--- |
| **TOTAL CALLS** | `totalcalls` | Integer | Total calls offered to the queue |
| **NOT READY AGENTS** | `unavailableagents` | Integer | Number of agents in Not Ready state |
| **READY AGENTS** | `availableagents` | Integer | Number of agents in Ready state |
| **TALKING AGENTS** | `talkingagents` | Integer | Number of agents currently talking |
| **ANSWERED CALLS** | `callshandled` | Integer | Calls handled by agents |
| **ABANDONED CALLS** | `callsabandoned` | Integer | Calls abandoned in queue |
| **CALLS WAITING** | `callswaiting` | Integer | Calls currently waiting in queue |
| **SL ANSWERED** | `callshandled` / `convcallscsq` | Integer | Calls handled within Service Level target |
| **SL ABANDONED** | `callsabandoned` | Integer | Calls abandoned within SL target |
| **LONGEST WAIT** | `convlongestwaitduration` | `HH:MM:SS` | Longest wait duration in queue |
| **AVG TALK TIME** | `convavgtalkduration` | `HH:MM:SS` | Average call talk duration |
| **AVG ABANDON TIME** | `convavgwaitduration` | `HH:MM:SS` | Average wait time before abandon |
| **AVG WAIT TIME** | `convavgwaitduration` | `HH:MM:SS` | Average queue wait duration |
| **SL RATIO (%)** | `servicelevelpercentage` | Percentage | Service Level achievement percentage |
| **ANSWER RATE (%)** | `(callshandled / totalcalls) * 100` | Percentage | Answer Rate (AR %) |

---

## 3. Required UCCX Server Pre-Configuration

For the Cisco CCX Engine to write real-time agent and call statistics into the Informix snapshot tables:

1. Sign in to **UCCX Administration** as an administrator:  
   `https://<UCCX_IP>/appadmin`
2. Navigate to **Tools** $\rightarrow$ **Real Time Snapshot Config**.
3. Under **Data Writing Configuration**:
   - ✅ Check **Cisco Unified CCX CSQs Summary**.
   - ✅ Check **Cisco Unified CCX System ICD Stats**.
4. Under **Server Configuration**, enter the Wallboard server IP (or UCCX IP) in the **Server IP** field.
5. Click **Update** to save.

---

## 4. Deploying with Docker Compose

You can deploy this application on any Linux (Ubuntu, Debian, RHEL, CentOS) or Windows Server host using Docker Compose.

### Step 1: Copy Project Files to the Target Server
Create a target directory on your server and copy the project files into it:
```bash
mkdir -p /opt/uccx-wallboard
cd /opt/uccx-wallboard
```

### Step 2: Configure `.env` and Review `docker-compose.yml`
Copy the sample environment file and set your actual UCCX IP, database password, and a strong admin password:

```bash
cp .env.example .env
# Edit .env and update UCCX_HOST, UCCX_SERVER, UCCX_PASSWORD, and ADMIN_PASSWORD
```

[`docker-compose.yml`](docker-compose.yml) reads environment variables from `.env`:

```yaml
version: '3.8'

services:
  uccx-wallboard:
    build: .
    container_name: uccx-wallboard
    restart: always
    ports:
      - "8080:8080"
    environment:
      - PORT=${PORT:-8080}
      - UCCX_HOST=${UCCX_HOST:?Set UCCX_HOST in .env}
      - UCCX_PORT=${UCCX_PORT:-1504}
      - UCCX_SERVER=${UCCX_SERVER:?Set UCCX_SERVER in .env}
      - UCCX_DATABASE=${UCCX_DATABASE:-db_cra}
      - UCCX_USER=${UCCX_USER:-uccxwallboard}
      - UCCX_PASSWORD=${UCCX_PASSWORD:?Set UCCX_PASSWORD in .env}
      - REFRESH_INTERVAL_MS=${REFRESH_INTERVAL_MS:-10000}
      - DEFAULT_CSQ=${DEFAULT_CSQ:-SALES}
      - DEFAULT_TEAM=${DEFAULT_TEAM:-Default}
      - DEFAULT_LANG=${DEFAULT_LANG:-tr}
      - MOCK_MODE=${MOCK_MODE:-false}
      - ADMIN_USER=${ADMIN_USER:-admin}
      - ADMIN_PASSWORD=${ADMIN_PASSWORD:?Set ADMIN_PASSWORD in .env}
      - ADMIN_SESSION_TTL_MS=${ADMIN_SESSION_TTL_MS:-28800000}
      - CORS_ORIGIN=${CORS_ORIGIN:-}
    volumes:
      - ./csqs.json:/app/csqs.json
```

### Step 3: Build and Start the Container
```bash
docker compose up -d --build
```

### Step 4: Check Container Logs
```bash
docker compose logs -f
```
Once you see the following output, the dashboard is ready:
```text
[UCCX DB] ✓ Informix portuna başarıyla bağlanıldı: 192.0.2.10:1504 (uccx_server_uccx)
[UCCX DB] ✓ RtCSQsSummary tablosundan 2 CSQ okundu: SERVICE, SALES
🚀 Cisco UCCX 12.5 Wallboard Dashboard Başlatıldı!
📡 URL: http://localhost:8080
```

### Step 5: Open in Browser
Open a browser on your TV or workstation:  
👉 `http://<SERVER_IP_ADDRESS>:8080`

---

## 5. Running in a Local Development Environment

### Prerequisites
* **Node.js** (v18, v20 or newer)
* **Java JRE / JDK 8+** (required by the Informix JDBC driver)

### Startup Commands
```bash
cp .env.example .env
# Edit UCCX and admin settings in .env
npm install
npm start
```

---

## 6. Environment Variables

> **Note:** `.env` and `admin-auth.json` are excluded by `.gitignore` and must never be committed to Git.

| Variable | Example / Default | Description |
| :--- | :--- | :--- |
| `PORT` | `8080` | Web server port |
| `UCCX_HOST` | `192.0.2.10` | UCCX server IP/hostname (must be set in `.env`) |
| `UCCX_PORT` | `1504` | Informix SQLI port (`1504`) |
| `UCCX_SERVER` | `uccx_server_uccx` | Informix instance name (`<hostname>_uccx`) |
| `UCCX_DATABASE` | `db_cra` | Cisco UCCX historical/real-time database name |
| `UCCX_USER` | `uccxwallboard` | Wallboard database username |
| `UCCX_PASSWORD` | `<UCCX_DB_PASSWORD>` | Database password (must be set in `.env`) |
| `REFRESH_INTERVAL_MS`| `10000` | Polling and WebSocket broadcast interval in ms (10s) |
| `DEFAULT_CSQ` | `SALES` | Default CSQ selected on startup |
| `DEFAULT_LANG` | `tr` | Default UI language (`tr`, `en`, `de`, `fr`, `es`) |
| `MOCK_MODE` | `false` | Live DB mode (`false`) or test simulation mode (`true`) |
| `ADMIN_USER` | `admin` | Default admin panel username |
| `ADMIN_PASSWORD` | `<STRONG_ADMIN_PASSWORD>` | Admin panel password (if unset, an ephemeral random password is generated at startup) |
| `ADMIN_SESSION_TTL_MS` | `28800000` | Admin session timeout in ms (default: 8 hours) |
| `CORS_ORIGIN` | _(empty)_ | Comma-separated allowed CORS origins (leave empty for same-origin only) |

---

## 7. User Interface Features

* **Admin Panel Security (Authentication):** The main TV Wallboard and live metrics are publicly viewable without login, while **`Admin Page`** (`Yönetim Paneli`) and **`+ CSQ`** actions require username/password authentication (with temporary rate-limiting after 5 failed attempts). If `ADMIN_PASSWORD` is omitted in `.env`, a random one-time password is generated and logged at startup. Updating the admin username and password (minimum 8 characters) inside **Change Admin Login Credentials** stores a salted `scrypt` hash in `admin-auth.json`.
* **Multi-Language Support (i18n):**
  * Supported languages: **Türkçe (`tr`)**, **English (`en`)**, **Deutsch (`de`)**, **Français (`fr`)**, and **Español (`es`)**.
  * Switch languages instantly without page reload using the **`🌐`** selector in the top bar (persisted in `localStorage` under `uccx_wallboard_lang`).
  * For TV/Kiosk displays, pass a URL query parameter directly: `http://<SERVER_IP>:8080/?lang=en` (or `tr`, `de`, `fr`, `es`).
  * Server-wide default language is configured via `DEFAULT_LANG` in `.env` or `docker-compose.yml` (Priority: `?lang=` > `localStorage` > `DEFAULT_LANG`).
  * To add another language, extend `supportedLangs`, `localeMap`, and `translations` in [`public/i18n.js`](public/i18n.js) and add an `<option>` inside `#langSelect` in [`public/index.html`](public/index.html).
* **Theme Switcher:**
  * One-click **`🌙 Dark Mode`** button for OLED/low-glare TV screens.
  * Dropdown selector with **Sunny**, **Cisco Navy**, and **Slate Gray** themes.
* **Slide Show (Auto-Cycle):**
  * Automatically cycles through configured CSQs every 10, 20, 30, or 60 seconds.
  * Top green progress bar visually indicates remaining time per queue.
* **Thresholds & Sound Alerts:**
  * Cards highlight red and trigger an audio alert when waiting calls $\ge 3$ or longest wait time $\ge 60$s (mutable via the speaker icon in the top bar).
* **Fullscreen (TV Mode):**
  * Click **`⛶`** in the top bar for distraction-free fullscreen display.
* **CSQ Management:**
  * Add a queue quickly with **`+ CSQ`** or batch-edit all queues in the Admin Panel.
