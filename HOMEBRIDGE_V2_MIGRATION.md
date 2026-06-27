# Homebridge-v2-Migration

Stand: 27. Juni 2026

## Ziel und Umfang

Diese Migration stellt `homebridge-dreo` auf Homebridge v2 und HAP v2 um, ohne
das bestehende HAP-Verhalten des Dreo DR-HAC006S zu verändern. Es wurden keine
Matter-Geräte oder Matter-Kopplungen eingerichtet.

Grundlage waren die offiziellen
[Homebridge-v2-Migrationshinweise](https://github.com/homebridge/homebridge/wiki/Updating-To-Homebridge-v2.0).
Das Plugin verwendet keine der dort für HAP v1 entfernten, veralteten APIs.

## Plugin-Änderungen

- Unterstützte Laufzeiten: Node.js `^22.12.0 || ^24.0.0` und Homebridge
  `^1.6.0 || ^2.0.0`.
- Entwicklung und Typprüfung gegen Homebridge 2 und HAP 2.
- TypeScript-Ziel ES2022 mit Node16-Modulauflösung.
- Homebridge-Importe sind reine Typimporte; das veröffentlichte Plugin bleibt
  mit dem CommonJS-Loader von Homebridge kompatibel.
- Initialisierung von HAP-Konstruktoren und Accessory-Kontextwerten erfolgt erst
  im Konstruktor, nachdem `api` beziehungsweise `accessory` verfügbar sind.
- Axios- und WebSocket-Fehler werden ohne Request-Header, Request-Body oder
  Zugangsdaten protokolliert.
- Automatisierte Tests decken die drei Modi, alle zwölf Kombinationen aus Modus
  und Lüfterstufe sowie Zielwerte, Swing, Display, Sleep und Eco ab.

## Lokale Verifikation

- `npm run lint`: erfolgreich
- `npm run build`: erfolgreich
- `npm test`: 18 Tests erfolgreich
- Plugin-Loader-Smoke mit Homebridge 1.11.4 / HAP 0.14.3: erfolgreich
- Plugin-Loader-Smoke mit Homebridge 2.1.0 / HAP 2.1.7: erfolgreich
- Paket: `homebridge-dreo-4.4.7.tgz`
- Paket-SHA-256:
  `b8f73fca3a4e68a3473a5c460415b18989f7651c440a501b6572c66fb7765719`
- Produktionsabhängigkeiten: keine bekannten npm-Audit-Funde

## Backup vor dem Upgrade

Vor Änderungen an Homebridge wurde auf dem Raspberry Pi ein vollständiges
Instanz-Backup unter `/var/lib/homebridge/backups/instance-backups/` erstellt.
Das Archiv enthält Konfiguration, Persist-Daten und Accessories-Cache.

- Größe: 433279 Byte
- SHA-256:
  `a82b9e097ac54894e1425854e87e14d8b398730214eb4fb8af717b42272d2fa7`
- Archivprüfung: Konfiguration 1 Eintrag, Persist 18 Einträge, Accessories
  9 Einträge

Accessories, Pairings und Persist-Daten wurden weder gelöscht noch
zurückgesetzt.

## Raspberry-Pi-Ergebnis

- Homebridge: 2.1.0
- HAP: 2.1.7
- Homebridge UI: 5.24.0
- Node.js: 24.14.1
- `homebridge-dreo`: 4.4.7
- Haupt- und Dreo-Child-Bridge lauschen weiterhin auf ihren bisherigen Ports.
- Die Dreo-Child-Bridge wurde aus dem bestehenden Cache wiederhergestellt und
  blieb gekoppelt.
- Nach Start und realen Gerätebefehlen: keine Dreo-, Fehler- oder
  Warnmeldungen im Homebridge-Log.

## Reale Geräteprüfung unter Homebridge v2

Am realen Gerät erfolgreich ausgeführt:

- Cooling, Dry und Fan sind gegenseitig ausschließend.
- Lüfter 1, 2, 3 und Auto in jedem der drei Modi: 12 von 12 Kombinationen.
- Zieltemperatur 21 → 22 → 21 °C.
- Zielluftfeuchtigkeit 60 → 55 → 60 %.
- Swing aus und wieder ein.
- Display aus und wieder ein.
- Sleep ein und wieder aus.
- Eco ein und wieder aus.

Wiederhergestellter Ausgangszustand:

- Cooling aktiv, 21 °C
- Lüfterstufe 1
- Swing und Display ein
- Dry, Fan, Sleep und Eco aus

Der Fanv2-Dienst `Ventilator` ist im HAP-Servicebestand und im
Accessories-Cache vollständig vorhanden und steuerbar. Homebridge UI 5.24.0
zeigt dafür in der gefilterten Kachelansicht keine eigene Kachel; das ist eine
Darstellungsabweichung der UI und kein fehlender oder defekter HAP-Dienst.

## Apple-Home-Verifikation

- Das bestehende Gerät ist in Apple Home weiterhin sichtbar.
- Die bisherigen Bedienelemente werden weiterhin angezeigt.
- Ein realer Befehl aus Apple Home wurde vom Gerät ausgeführt.
