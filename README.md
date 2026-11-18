# Cisco UCCX 12.5 ve 15 Real-Time Wallboard Dashboard

🇹🇷 **Türkçe** | 🇬🇧 [English (README.en.md)](README.en.md)

Bu proje, **Cisco Unified Contact Center Express (UCCX) 12.5 ve 15** sistemlerindeki gerçek zamanlı kuyruk (CSQ) ve temsilci (Agent) hareketlerini anlık olarak okuyan, büyük TV ekranlarına ve operasyon merkezlerine uyumlu modern bir Wallboard uygulamasıdır.

---

## 📋 İçindekiler
1. [Mimarisi ve Çalışma Prensibi](#1-mimarisi-ve-çalışma-prensibi)
2. [UCCX 12.5 Veritabanı Şeması ve Kolon Eşleşmeleri](#2-uccx-125-veritabanı-şeması-ve-kolon-eşleşmeleri)
3. [UCCX Sunucusunda Gerekli Ön Ayarlar (Snapshot Config)](#3-uccx-sunucusunda-gerekli-ön-ayarlar-snapshot-config)
4. [Docker Compose ile Başka Bir Sunucuya Kurulum](#4-docker-compose-ile-başka-bir-sunucuya-kurulum)
5. [Yerel Geliştirme Ortamında Çalıştırma](#5-yerel-geliştirme-ortamında-çalıştırma)
6. [Ortam Değişkenleri (.env)](#6-ortam-değişkenleri-env)
7. [Arayüz Özellikleri](#7-arayüz-özellikleri)

---

## 1. Mimarisi ve Çalışma Prensibi

* **Veritabanı Motoru:** IBM Informix Dynamic Server (IDS) - `db_cra`
* **Bağlantı Protokolü:** Informix SQLI (`onsoctcp`) - Port `1504`
* **Sürücü:** IBM Informix JDBC Driver (`ifxjdbc.jar`)
* **Backend:** Node.js (Express + WebSocket `ws`)
* **Frontend:** Modern, TV/Wallboard duyarlı saf HTML5/CSS3/Vanilla JS (WebSockets üzerinden 10 saniyede bir otomatik push).
* **Temalar:** Sunny (Orijinal bej/altın), Dark TV (OLED siyahı), Cisco Navy (Mavi kurumsal) ve Slate Gray.

---

## 2. UCCX 12.5 Veritabanı Şeması ve Kolon Eşleşmeleri

[Cisco UCCX 12.5 Database Schema Guide](https://www.cisco.com/c/en/us/td/docs/voice_ip_comm/cust_contact/contact_center/crs/express_12_5/reference/guide/uccx_b_125db-schema-guide/uccx_b_125db-schema-guide_chapter_01.html) uyarınca gerçek zamanlı wallboard verileri **`RtCSQsSummary`** (Kuyruk Bazlı) ve **`RtICDStatistics`** (Tüm Merkez / OverAll) tablolarından çekilir:

| Arayüzdeki Kart | Informix Kolonu (`RtCSQsSummary`) | Tip / Format | Açıklama |
| :--- | :--- | :--- | :--- |
| **TOPLAM ÇAĞRI** | `totalcalls` | Integer | Kuyruğa gelen toplam çağrı adedi |
| **MÜSAİT OLMAYAN MT** | `unavailableagents` | Integer | 'Not Ready' durumundaki temsilci sayısı |
| **MÜSAİT MT** | `availableagents` | Integer | 'Ready' durumundaki temsilci sayısı |
| **GÖRÜŞEN MT** | `talkingagents` | Integer | Görüşmede/çağrıda olan temsilci sayısı |
| **CEVAPLANAN ÇAĞRILAR** | `callshandled` | Integer | Temsilcilerce cevaplanan çağrılar |
| **KAÇAN ÇAĞRILAR** | `callsabandoned` | Integer | Kuyrukta terk edilen çağrılar |
| **BEKLEYEN ÇAĞRILAR** | `callswaiting` | Integer | Şu an kuyrukta bekleyen anlık çağrılar |
| **SL CEVAPLANAN** | `callshandled` / `convcallscsq` | Integer | Servis Seviyesi hedefi içinde karşılananlar |
| **SL KAÇAN** | `callsabandoned` | Integer | SL hedefi içinde kaçanlar |
| **EN UZUN BEKLEME** | `convlongestwaitduration` | `HH:MM:SS` | Kuyrukta en uzun bekleyen çağrının süresi |
| **ORTALAMA GÖRÜŞME** | `convavgtalkduration` | `HH:MM:SS` | Ortalama konuşma süresi |
| **ORTALAMA KAÇAN** | `convavgwaitduration` | `HH:MM:SS` | Kaçan çağrıların bekleme süresi |
| **ORTALAMA BEKLEME** | `convavgwaitduration` | `HH:MM:SS` | Ortalama kuyrukta bekleme süresi |
| **SL ORANI (%)** | `servicelevelpercentage` | Yüzde | Servis Seviyesi karşılanma oranı |
| **AR ORANI (%)** | `(callshandled / totalcalls) * 100` | Yüzde | Cevaplama Oranı (Answer Rate) |

---

## 3. UCCX Sunucusunda Gerekli Ön Ayarlar (Snapshot Config)

Cisco CCX Engine'in bu tablolara anlık temsilci ve çağrı hareketlerini yazabilmesi için:

1. **UCCX Administration** sayfasına yönetici olarak giriş yapın:  
   `https://<UCCX_IP>/appadmin`
2. **Tools** $\rightarrow$ **Real Time Snapshot Config** menüsünü açın.
3. **Data Writing Configuration** altında:
   - ✅ **Cisco Unified CCX CSQs Summary** seçeneğini işaretleyin.
   - ✅ **Cisco Unified CCX System ICD Stats** seçeneğini işaretleyin.
4. **Server Configuration** altındaki **Server IP** kutusuna:
   - Wallboard uygulamasının çalıştığı sunucunun IP adresini (veya UCCX IP adresini) yazın.
5. **Update** butonuna basarak kaydedin.

---

## 4. Docker Compose ile Başka Bir Sunucuya Kurulum

Bu uygulamayı Linux (Ubuntu, Debian, RHEL, CentOS) veya Windows Server yüklü herhangi bir sunucuya Docker ile tek komutla kurabilirsiniz.

### Adım 1: Proje Dosyalarını Hedef Sunucuya Kopyalayın
Hedef sunucuda bir klasör açıp projenin tüm dosyalarını buraya aktarın:
```bash
mkdir -p /opt/uccx-wallboard
cd /opt/uccx-wallboard
```

### Adım 2: `.env` ve `docker-compose.yml` Dosyalarını Hazırlayın
Örnek ortam dosyasını kopyalayıp gerçek UCCX IP, veritabanı şifresi ve güçlü bir yönetici şifresi tanımlayın:

```bash
cp .env.example .env
# .env dosyasını açarak UCCX_HOST, UCCX_SERVER, UCCX_PASSWORD ve ADMIN_PASSWORD değerlerini güncelleyin
```

[`docker-compose.yml`](docker-compose.yml) ortam değişkenlerini `.env` üzerinden okur:

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

### Adım 3: Konteyneri Derleyin ve Başlatın
```bash
docker compose up -d --build
```

### Adım 4: Logları İnceleyin
```bash
docker compose logs -f
```
Loglarda şu çıktıyı gördüğünüzde uygulama hazırdır:
```text
[UCCX DB] ✓ Informix portuna başarıyla bağlanıldı: 192.0.2.10:1504 (uccx_server_uccx)
[UCCX DB] ✓ RtCSQsSummary tablosundan 2 CSQ okundu: SERVICE, SALES
🚀 Cisco UCCX 12.5 Wallboard Dashboard Başlatıldı!
📡 URL: http://localhost:8080
```

### Adım 5: Tarayıcıdan Erişin
TV veya istemci bilgisayarından tarayıcıyı açın:
👉 `http://<SUNUCU_IP_ADRESI>:8080`

---

## 5. Yerel Geliştirme Ortamında Çalıştırma

### Gereksinimler:
* **Node.js** (v18, v20 veya üzeri)
* **Java JRE / JDK 8+** (Informix JDBC sürücüsü için)

### Başlatma Komutu:
```bash
cp .env.example .env
# .env içindeki UCCX ve yönetici bilgilerini düzenleyin
npm install
npm start
```

---

## 6. Ortam Değişkenleri (.env)

> **Not:** `.env` ve `admin-auth.json` dosyaları `.gitignore` ile korunur; kesinlikle Git reposuna eklenmemelidir.

| Değişken | Örnek / Varsayılan | Açıklama |
| :--- | :--- | :--- |
| `PORT` | `8080` | Web sunucu portu |
| `UCCX_HOST` | `192.0.2.10` | UCCX sunucu IP adresi (`.env` içinde tanımlanmalı) |
| `UCCX_PORT` | `1504` | Informix SQLI portu (1504) |
| `UCCX_SERVER` | `uccx_server_uccx` | Informix Instance Adı (`<hostname>_uccx`) |
| `UCCX_DATABASE` | `db_cra` | Cisco UCCX veritabanı adı |
| `UCCX_USER` | `uccxwallboard` | Wallboard veritabanı kullanıcısı |
| `UCCX_PASSWORD` | `<UCCX_DB_PASSWORD>` | Veritabanı şifresi (`.env` içinde tanımlanmalı) |
| `REFRESH_INTERVAL_MS`| `10000` | Veri çekme ve yenileme sıklığı (10 sn) |
| `DEFAULT_CSQ` | `SALES` | İlk açılışta seçilen varsayılan kuyruk |
| `DEFAULT_LANG` | `tr` | Varsayılan arayüz dili (`tr`, `en`, `de`, `fr`, `es`) |
| `MOCK_MODE` | `false` | Canlı bağlantı (`false`), test simülasyonu (`true`) |
| `ADMIN_USER` | `admin` | Yönetim paneli varsayılan kullanıcı adı |
| `ADMIN_PASSWORD` | `<STRONG_ADMIN_PASSWORD>` | Yönetim paneli şifresi (tanımlı değilse başlangıçta tek kullanımlık şifre üretilir) |
| `ADMIN_SESSION_TTL_MS` | `28800000` | Yönetim paneli oturum süresi (milisaniye, varsayılan 8 saat) |
| `CORS_ORIGIN` | _(boş)_ | İzin verilen çapraz origin adresleri (virgülle ayrılmış; boşsa yalnızca aynı origin) |

---

## 7. Arayüz Özellikleri

* **Yönetim Paneli Güvenliği (Authentication):** TV/Duvar ekranı ve canlı metrikler oturum açmadan herkese açık görüntülenir; **`Yönetim Paneli`** ve **`+ CSQ`** işlemleri ise kullanıcı adı/şifre doğrulaması gerektirir (5 hatalı denemede geçici rate-limit uygulanır). `.env` içinde `ADMIN_PASSWORD` verilmemişse başlangıçta rastgele geçici yönetici şifresi üretilip sunucu loguna yazılır. Panel içindeki **Yönetici Kimlik Bilgileri** bölümünden kullanıcı adı ve en az 8 karakterli yeni şifre tanımlandığında `admin-auth.json` dosyasında tuzlanmış `scrypt` hash olarak saklanır.
* **Çoklu Dil Desteği (Multi-Language / i18n):**
  * Desteklenen diller: **Türkçe (`tr`)**, **English (`en`)**, **Deutsch (`de`)**, **Français (`fr`)** ve **Español (`es`)**.
  * Sağ üstteki **`🌐`** dil menüsünden sayfa yenilenmeden anında dil değiştirilebilir; seçim tarayıcı `localStorage` (`uccx_wallboard_lang`) içinde saklanır.
  * TV/Kiosk ekranları için URL parametresiyle doğrudan dil seçilebilir: `http://<SUNUCU_IP>:8080/?lang=en` (veya `tr`, `de`, `fr`, `es`).
  * Sunucu genelinde varsayılan dil `.env` veya `docker-compose.yml` içindeki `DEFAULT_LANG` değişkeniyle belirlenir (Öncelik sırası: `?lang=` > `localStorage` > `DEFAULT_LANG`).
  * Yeni dil eklemek için [`public/i18n.js`](public/i18n.js) dosyasındaki `supportedLangs`, `localeMap` ve `translations` nesnelerine yeni dil kodunu ekleyip `public/index.html` içindeki `#langSelect` listesine `<option>` eklemek yeterlidir.
* **Tema Değiştirici:**
  * **`🌙 Dark Mode`** butonu ile tek tıkla karanlık TV moduna geçiş.
  * Dropdown menüden **Sunny** (orijinal sarı), **Cisco Navy** (mavi kurumsal) ve **Slate Gray** seçenekleri.
* **Slide Show (Otomatik Döngü):**
  * Tanımlı kuyruklar arasında 10, 20, 30 veya 60 saniyede bir otomatik geçiş yapar.
  * Üstteki yeşil ilerleme çubuğu ile kalan süre görsel olarak izlenebilir.
* **Eşik Değer & Sesli Alarm:**
  * Bekleyen çağrı $\ge 3$ veya bekleme süresi $\ge 60$ sn olduğunda ilgili kart kırmızı yanıp söner ve sesli ikaz verir (sağ üstteki hoparlör simgesinden kapatılabilir).
* **Tam Ekran (TV Modu):**
  * Üst bardaki **`⛶`** butonu ile tarayıcı tam ekran moduna geçer, kaydırma çubukları gizlenir.
* **CSQ Yönetimi:**
  * Üst bardaki **`+ CSQ`** butonu ile anında yeni kuyruk adı eklenebilir veya Admin sayfasından toplu düzenleme yapılabilir.
