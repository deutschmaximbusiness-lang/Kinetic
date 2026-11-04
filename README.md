# Kinetic

Web-App (PWA) fürs iPhone: Gewicht, Retatrutid-Einnahmen, Fotos, Studien und Share-Karte.
Alle Daten bleiben lokal auf dem iPhone (IndexedDB). Es gibt keinen Server und keinen Account.

## Online stellen (GitHub Pages)
1. Neues Repo auf GitHub anlegen, z. B. `kinetic`.
2. Den Inhalt dieses Ordners hochladen (index.html, app.js, styles.css, sw.js, manifest.json, die Icon-PNGs).
3. Repo → Settings → Pages → Source: `main`, Ordner `/ (root)` → Save.
4. Nach 1–2 Minuten läuft die App unter `https://<dein-name>.github.io/kinetic/`.

## Aufs iPhone holen
1. Den Link in **Safari** öffnen (nicht Chrome).
2. Teilen-Symbol → **Zum Home-Bildschirm**.
3. Ab jetzt Kinetic nur über das Icon öffnen. Die Daten gehören zu dieser Home-Bildschirm-App.

## Updates
Bei jeder Änderung in `sw.js` die Zeile `const CACHE = 'kinetic-v1'` hochzählen (v2, v3 …),
sonst zeigt das iPhone eventuell noch die alte Version. App danach einmal schließen und neu öffnen.

## Backup
Einstellungen (Zahnrad auf „Heute") → Backup exportieren. Regelmäßig machen, z. B. in die Dateien-App.
Fotos sind im Backup nicht enthalten.

## Dateien
- `index.html` – Grundgerüst
- `styles.css` – Design (Farben oben in `:root`)
- `app.js` – gesamte Logik: Speicher, Screens, Chart, Share-Karte
- `sw.js` – Offline-Cache
- `manifest.json`, `*.png` – App-Icon und Name
