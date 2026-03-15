# CLAUDE.md — Contexte pour Claude Code & agents IA

> Ce fichier est lu automatiquement par Claude Code au démarrage d'une session.
> Il fournit le contexte projet nécessaire pour travailler efficacement.

## Identité du projet

**wdoc** est un format de document ouvert conçu comme alternative moderne au PDF.
Un fichier `.wdoc` est une archive ZIP contenant du HTML/CSS natif, un manifeste d'intégrité SHA-256, et des assets embarqués.

## Structure du monorepo

```
wdoc-monorepo/
├── app.wdoc.info/        # Angular 20 — viewer/editor (produit principal)
├── backend.wdoc.info/    # Bun + Hono — API auth (OTP + JWT + SQLite)
├── www.wdoc.info/        # Astro — site marketing/blog
├── examples.wdoc.info/   # Fixtures .wdoc pour tests et debug
└── .github/workflows/    # CI/CD (path-scoped par sous-projet)
```

## Commandes essentielles

### Frontend (app.wdoc.info)
```bash
cd app.wdoc.info && npm ci
npm start                    # Dev server sur :4200
npm test                     # Tests Karma/Jasmine
npm test -- --watch=false --browsers=ChromeHeadlessNoSandbox --code-coverage
npm run build -- --configuration=production
npm run e2e                  # Playwright
```

### Backend (backend.wdoc.info)
```bash
cd backend.wdoc.info && bun install
bun run dev                  # Dev server sur :3000 (watch)
bun test                     # Tests intégrés Bun
bun test --coverage          # Avec couverture
```

### Site web (www.wdoc.info)
```bash
cd www.wdoc.info && npm ci
npm run dev                  # Dev server sur :4321
npm run build                # Build statique
```

## Architecture technique

### Frontend — Angular 20
- **Composants** : tous `standalone: true`, change detection `OnPush`
- **État** : RxJS BehaviorSubject (pas de store externe)
- **Éditeur** : TipTap avec extensions (StarterKit, Color, Highlight, Image)
- **Rendu** : Shadow DOM pour isoler le HTML des .wdoc
- **Sécurité** : DOMPurify pour sanitisation, vérification SHA-256 du manifeste
- **ZIP** : JSZip (écriture), StreamedZip custom (lecture)
- **Éléments custom** : `wdoc-page`, `wdoc-container`, `wdoc-content`, `wdoc-header`, `wdoc-footer`, `wdoc-barcode`, `wdoc-qr`
- **Tests** : Karma + Jasmine, seuils coverage = 80% (statements/functions/lines), 60% (branches)
- **PWA** : Angular Service Worker (ngsw)

### Backend — Bun + Hono
- **Base de données** : SQLite (WAL mode), 2 tables (users, login_codes)
- **Auth** : Passwordless OTP email → JWT (jose)
- **Validation** : Zod + @hono/zod-validator
- **Email** : Abstraction provider (console dev / AWS SES prod)
- **Rate limiting** : In-memory window-based
- **Routes** : POST /login, POST /loginvalidate, OPTIONS (CORS)
- **Tests** : Bun test runner natif

### Déploiement
- **Frontend** : GitHub Pages (gh-pages branch, CNAME app.wdoc.info)
- **Site web** : GitHub Pages (CNAME www.wdoc.info)
- **Backend** : Déploiement manuel (pas de CD automatique)
- **CI** : GitHub Actions avec path-filters par sous-projet

## Variables d'environnement backend

| Variable | Défaut | Description |
|----------|--------|-------------|
| PORT | 3000 | Port serveur |
| DATABASE_URL | ./data/dev.db | Chemin SQLite |
| CORS_ORIGINS | localhost:4200,app.wdoc.info | Origins CORS |
| JWT_SECRET | dev-jwt-secret | Secret JWT |
| JWT_EXPIRES_IN_SECONDS | 604800 | Durée token (7j) |
| OTP_EXPIRES_IN_MINUTES | 10 | Durée OTP |
| EMAIL_PROVIDER | console | console ou ses |
| RATE_LIMIT_MAX | 5 | Max requêtes /login par fenêtre |

## État actuel de la couverture de tests

### Frontend (mars 2026)
| Métrique | Couverture | Seuil | Statut |
|----------|-----------|-------|--------|
| Statements | 81.33% | 80% | ✅ |
| Branches | 68.44% | 60% | ✅ |
| Functions | 82.55% | 80% | ✅ |
| Lines | 81.31% | 80% | ✅ |

⚠️ 6 tests en échec à corriger. La couverture des branches reste le point faible.

### Backend
- Couverture non mesurée en CI. Un seul fichier de test (auth.test.ts).

## Flux de données critiques

### Chargement d'un .wdoc
```
Fichier/URL → WdocLoaderService (parse ZIP)
  → Vérification manifest SHA-256
  → HtmlProcessingService (DOMPurify + images + QR/barcodes)
  → HtmlPageSplitter (pagination client-side)
  → ViewerComponent (Shadow DOM + zoom)
  → FormManagerService (restauration formulaires)
```

### Export d'un .wdoc
```
TipTap Editor → contentChange/assetsChange
  → DocumentCreatorService
  → Build ZIP (index.html + manifest.json + wdoc-form/ + wdoc-assets/)
  → Téléchargement blob
```

### Authentification
```
Email → POST /login → OTP email
OTP → POST /loginvalidate → JWT
JWT stocké en localStorage (wdoc-auth-session)
```

## Pièges courants

1. **Pagination** : `splitHtmlToPages.ts` provoque des reflows. Risque de boucles infinies si mal modifié.
2. **JSZip est async** : toujours `await` les opérations ZIP.
3. **CSS isolation** : les styles dans `wdoc-styles.css` sont globaux — ne pas polluer le contenu des pages .wdoc.
4. **Éléments custom wdoc-*** : ne pas les retirer des allow-lists DOMPurify.
5. **Config prod** : `angular.json` fait un file replacement de `app.config.ts` → `app.config.production.ts`.
6. **Pas de types partagés** : frontend et backend redéfinissent leurs types indépendamment.
7. **SQLite** : pas adapté au multi-instance en prod, prévoir migration PostgreSQL pour le scale.

## Conventions de code

- TypeScript strict partout
- Nommage : `*.component.ts`, `*.service.ts`, `*.spec.ts`
- Tests colocalisés avec le code source
- Pas de NgModule (standalone only)
- Injection : `@Injectable({ providedIn: 'root' })`
- Backend : injection de dépendances via `createApp()` factory
- Pas de linter/formatter configuré (ni ESLint ni Prettier)
