# Sahibinden.com Emlak Scraper 🏠

Sahibinden.com üzerindeki emlak ilanlarını (satılık daire, kiralık daire, arsa, villa vb.) otomatik olarak çeken Apify Actor.

## 🇬🇧 English

A powerful Apify Actor that scrapes real estate listings from Sahibinden.com (Turkey's largest classified ads platform). Extracts property details including price, location, size, rooms, building age, and more.

### Features

- ✅ **Cloudflare Bypass** — Puppeteer + Stealth plugin
- ✅ **Residential Proxy** — Required for Sahibinden.com (TR country code)
- ✅ **Detail Pages** — Optional: scrape full property details, photos, and seller info
- ✅ **Pagination** — Automatically navigates through all result pages
- ✅ **BaseRow Integration** — Optional: store data directly in BaseRow
- ✅ **Human-like Behavior** — Random delays, user agents, and viewport sizes

### Input

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `startUrls` | Array | `satilik-daire/istanbul` | Sahibinden.com category page URLs |
| `maxItems` | Integer | All | Maximum number of listings to scrape |
| `includeDetails` | Boolean | `false` | Scrape detail pages for full info |
| `maxConcurrency` | Integer | `3` | Max concurrent pages (3-5 recommended) |
| `proxyConfiguration` | Object | RESIDENTIAL/TR | Proxy settings |

### Output (Basic - `includeDetails: false`)

```json
{
    "id": "1234567890",
    "url": "https://www.sahibinden.com/ilan/...",
    "title": "3+1 Satılık Daire Kadıköy",
    "price": 4500000,
    "price_currency": "TL",
    "location": "İstanbul / Kadıköy",
    "date": "21 Şubat 2026",
    "image": "https://...",
    "scrapedAt": "2026-02-21T12:00:00.000Z",
    "sourceUrl": "https://www.sahibinden.com/satilik-daire/istanbul"
}
```

### Output (Detailed - `includeDetails: true`)

Additional fields when detail scraping is enabled:

```json
{
    "description": "Kadıköy merkezde...",
    "images": ["https://...", "https://..."],
    "seller": "Emlak Ofisi",
    "rooms": "3+1",
    "size": "140 / 120",
    "buildingAge": "5-10",
    "floor": "3",
    "totalFloors": "8",
    "heating": "Doğalgaz",
    "furnished": "Hayır",
    "usage": "Boş",
    "inSite": "Evet",
    "dues": "500 TL",
    "deedStatus": "Kat Mülkiyeti",
    "creditEligible": "Evet",
    "info": {
        "Oda Sayısı": "3+1",
        "Brüt / Net M2": "140 / 120",
        "...": "..."
    }
}
```

### Supported URL Formats

```
# Category-based
https://www.sahibinden.com/satilik-daire/istanbul
https://www.sahibinden.com/kiralik-daire/aydin
https://www.sahibinden.com/satilik-arsa/izmir
https://www.sahibinden.com/satilik-villa/antalya

# With filters
https://www.sahibinden.com/satilik-daire/istanbul?sorting=date_desc&pagingSize=50
```

### Usage Example (API)

```javascript
const Apify = require('apify');

const run = await Apify.call('YOUR_USERNAME/sahibinden-emlak-scraper', {
    startUrls: [
        { url: 'https://www.sahibinden.com/satilik-daire/istanbul?sorting=date_desc' }
    ],
    maxItems: 100,
    includeDetails: false,
    maxConcurrency: 3,
    proxyConfiguration: {
        useApifyProxy: true,
        apifyProxyGroups: ['RESIDENTIAL'],
        countryCode: 'TR'
    }
});
```

### ⚠️ Important Notes

- **RESIDENTIAL proxy is required** — Sahibinden.com blocks datacenter IPs
- **Keep `maxConcurrency` at 3-5** — Higher values increase ban risk
- **Country code `TR`** — Turkish residential proxies work best
- **Selectors may change** — Sahibinden.com updates their HTML periodically

---

## 🇹🇷 Türkçe

### Özellikler

- ✅ **Cloudflare Bypass** — Puppeteer + Stealth plugin ile
- ✅ **Residential Proxy** — Sahibinden.com için zorunlu (TR)
- ✅ **Detay Sayfaları** — Opsiyonel: tüm özellikler, fotoğraflar, ilan sahibi
- ✅ **Sayfalama** — Otomatik olarak tüm sonuç sayfalarını gezer
- ✅ **BaseRow Entegrasyonu** — Opsiyonel: verileri BaseRow'a kaydedin
- ✅ **İnsan Davranışı** — Rastgele gecikmeler, user agent'lar

### Kullanım

1. Actor'ı Apify Store'dan çalıştırın
2. `startUrls`'e Sahibinden.com emlak kategori sayfası ekleyin
3. `maxItems` ile ilan limiti belirleyin
4. Detaylı bilgi istiyorsanız `includeDetails: true` yapın
5. Proxy olarak **RESIDENTIAL** seçin, ülke kodu **TR**

### Fiyatlandırma

| Mod | Fiyat | Açıklama |
|-----|-------|----------|
| Temel (Liste) | ~1000 ilan / $1 | Sadece liste verisi |
| Detaylı | ~500 ilan / $1 | Liste + detay sayfası + fotoğraflar |

### Proxy Maliyeti

- RESIDENTIAL proxy: ~$12.5/GB
- Tahmini kullanım: ~500 MB/ay
- Aylık maliyet: ~$6
