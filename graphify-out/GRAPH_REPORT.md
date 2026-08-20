# Graph Report - .  (2026-08-20)

## Corpus Check
- 219 files · ~131,176 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1204 nodes · 3318 edges · 149 communities (52 shown, 97 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 46 edges (avg confidence: 0.69)
- Token cost: 0 input · 581,785 output

## Community Hubs (Navigation)
- Core UI Primitives (Picker/Combobox/Modal)
- ESLint Configuration
- Database Schema & Field Model
- SQL Rendering Engine
- Project Docs & Governance
- Accordion & Dropdown Menu UI
- Internationalization (i18n) Locales
- App Navigation Shell
- UI Primitives (Alert/Avatar/Card)
- Database History & Relationship Model
- ER Diagram Canvas Rendering
- SQL Import Data Model
- TypeScript App Config
- Sidebar Navigation Data
- Field Editing & Renderer Props
- Form Input UI Controls
- Button/Clipboard/Tooltip UI
- Database Modal & Provider Hooks
- shadcn/ui Component Config
- Field & Relationship Modals
- Per-Dialect Data Type Definitions
- MySQL/MariaDB Import & Render
- Form Widget UI (Badge/Calendar/Radio)
- Menu & Menubar UI
- Database History & Diff Provider
- Theme & Code Editor Providers
- PowerSync Sync & Data Type Seeding
- Core Schema Type Definitions
- NPM Runtime Dependencies
- Header & Toggle UI Components
- SQL Import Parser Core
- List/Controller UI Components
- NPM Dev Dependencies
- Drawer & Mobile Layout UI
- Package Scripts & Metadata
- MSSQL/Oracle/Postgres Importers
- Vite & Node TS Config
- App Routing
- Spinner Icon Components
- Sheet UI Component
- Diagram Cardinality & Context
- Table UI & Open Database Modal
- Render/Data-Type Test Utilities
- Database Layout & Loading Modal
- Search Provider & UI
- Field Model & Table Accordion
- Oracle SQL Importer
- Font Provider
- PostgreSQL SQL Importer
- Root TypeScript Config
- SQLite Brand Assets
- App Entry Shell & Favicon
- MariaDB Brand Assets
- class-variance-authority Dependency
- cmdk Command Palette Dependency
- CodeMirror SQL Language Dependency
- cross-env Build Dependency
- dayjs Date Dependency
- dnd-kit Core Drag/Drop Dependency
- dnd-kit Sortable Dependency
- Drizzle ORM Dependency
- elkjs Layout Dependency
- esbuild Bundler Dependency
- ESLint Core Dependency
- eslint-config-prettier Dependency
- eslint-plugin-import Dependency
- eslint-plugin-jsx-a11y Dependency
- eslint-plugin-prettier Dependency
- eslint-plugin-react Dependency
- eslint-plugin-react-hooks Dependency
- fast-json-patch Dependency
- framer-motion Animation Dependency
- sqlparser-ts Dependency
- internationalized/date Dependency
- lodash Utility Dependency
- lucide-react Icons Dependency
- nextui-org/react Dependency
- node-sql-parser Dependency
- pgsql-ast-parser Dependency
- pluralize Dependency
- PowerSync Drizzle Driver Dependency
- PowerSync React Dependency
- Radix Accordion Dependency
- Radix Avatar Dependency
- Radix Collapsible Dependency
- Radix Dialog Dependency
- Radix Dropdown Menu Dependency
- Radix Label Dependency
- Radix Popover Dependency
- Radix Radio Group Dependency
- Radix Select Dependency
- Radix Separator Dependency
- Radix Slot Dependency
- Radix Switch Dependency
- Radix Toggle Dependency
- Radix Tooltip Dependency
- React Core Dependency
- react-aria Visually Hidden Dependency
- react-day-picker Dependency
- react-dom Dependency
- react-i18next Dependency
- react-resizable-panels Dependency
- react-router-dom Dependency
- react-tag-input Dependency
- react-types/shared Dependency
- react-use-hotkeys Dependency
- sonner Toast Dependency
- sql-formatter Dependency
- tabler-icons Dependency
- tailwind-merge Dependency
- tailwind-variants Dependency
- Tailwind CSS Dependency
- tailwindcss-animate Dependency
- Tailwind Typography Plugin Dependency
- Tailwind Vite Plugin Dependency
- uiw/react-codemirror Dependency
- use-undo Dependency
- uuid Dependency
- vaul Drawer Dependency
- xyflow/react Diagram Dependency
- rollup Bundler Dependency
- tw-animate-css Dependency
- @types/node Dependency
- @types/object-hash Dependency
- @types/pluralize Dependency
- @types/react Dependency
- @types/react-dom Dependency
- typescript-eslint Plugin Dependency
- typescript-eslint Parser Dependency
- Vite Build Tool Dependency
- vite-plugin-top-level-await Dependency
- vite-tsconfig-paths Dependency
- vitejs/plugin-react Dependency
- Vitest Test Runner Dependency
- Database Browser Icon
- HeidiSQL GUI Tool Reference
- MySQL Brand Assets
- PostgreSQL Brand Assets
- SSMS Tool Reference
- Vercel Deployment Config
- Nginx Deployment Configuration
- Bug Report Issue Template
- Oracle Brand Assets
- SQL Server Brand Assets
- Database Run Query Icon
- StackRender App Logo

## God Nodes (most connected - your core abstractions)
1. `cn()` - 178 edges
2. `react` - 97 edges
3. `FieldType` - 66 edges
4. `TableType` - 61 edges
5. `DataType` - 54 edges
6. `useDatabaseOperations()` - 49 edges
7. `DatabaseDialect` - 43 edges
8. `RelationshipType` - 40 edges
9. `Button` - 30 edges
10. `BaseSqlImporter` - 27 edges

## Surprising Connections (you probably didn't know these)
- `StackRender Studio HTML entry shell` --semantically_similar_to--> `StackRender (project)`  [INFERRED] [semantically similar]
  index.html → README.md
- `StackRender Logo` --conceptually_related_to--> `StackRender (project)`  [INFERRED]
  public/stackrenderlogo.png → README.md
- `StackRender Favicon (favicon.png)` --conceptually_related_to--> `StackRender (project name, package.json)`  [INFERRED]
  public/favicon.png → package.json
- `Contributing Guide` --conceptually_related_to--> `CI Workflow`  [INFERRED]
  CONTRIBUTING.md → .github/workflows/ci.yml
- `Security Policy` --shares_data_with--> `Contributor Covenant Code of Conduct`  [INFERRED]
  SECURITY.md → CODE_OF_CONDUCT.md

## Import Cycles
- 3-file cycle: `src/utils/render/database/mariadb-renderer.ts -> src/utils/render/database/mysql-renderer.ts -> src/utils/render/render-uttils.ts -> src/utils/render/database/mariadb-renderer.ts`
- 3-file cycle: `src/utils/render/database/base-database-renderer.ts -> src/utils/render/render-uttils.ts -> src/utils/render/database/mssql-database-renderer.ts -> src/utils/render/database/base-database-renderer.ts`
- 3-file cycle: `src/utils/render/database/base-database-renderer.ts -> src/utils/render/render-uttils.ts -> src/utils/render/database/oracle-renderer.ts -> src/utils/render/database/base-database-renderer.ts`
- 5-file cycle: `src/utils/render/database/base-database-renderer.ts -> src/utils/render/render-uttils.ts -> src/utils/render/database/mariadb-renderer.ts -> src/utils/render/database/mysql-renderer.ts -> src/utils/render/database/base-sql-renderer.ts -> src/utils/render/database/base-database-renderer.ts`

## Hyperedges (group relationships)
- **Open Source Contribution Workflow (Contributing Guide + Code of Conduct + PR Template)** — contributing_guide, code_of_conduct_policy, github_pull_request_template_pr_template [INFERRED 0.85]
- **Docker Deployment Pipeline (Guide + Compose Service + Multi-Stage Build)** — docker_deployment_guide, docker_compose_service, docker_multi_stage_build [INFERRED 0.85]

## Communities (149 total, 97 thin omitted)

### Community 0 - "Core UI Primitives (Picker/Combobox/Modal)"
Cohesion: 0.10
Nodes (30): ColorPickerProps, ComboboxProps, AnimationConfig, MultiSelectGroup, MultiSelectOption, MultiSelectProps, MultiSelectRef, multiSelectVariants (+22 more)

### Community 1 - "ESLint Configuration"
Cohesion: 0.05
Nodes (43): jsx, env, browser, es2021, node, extends, parser, parserOptions (+35 more)

### Community 2 - "Database Schema & Field Model"
Cohesion: 0.12
Nodes (32): FieldList(), IndexesList(), drizzleSchema, DatabaseInsertType, databaseRelations, field_indices, FieldIndexInsertType, FieldIndexType (+24 more)

### Community 3 - "SQL Rendering Engine"
Cohesion: 0.08
Nodes (7): TableAccordionBodyProps, TableType, ASTStatment, BaseSQLRenderer, MSSqlRenderer, OracleRenderer, SqliteRenderer

### Community 4 - "Project Docs & Governance"
Cohesion: 0.06
Nodes (38): Contributor Covenant (v2.0), Mozilla Code of Conduct Enforcement Ladder, Contributor Covenant Code of Conduct, AGPLv3 Contributor License Agreement, StackRender Discord Community, Contributing Guide, Docker Compose healthcheck block, stackrender Docker Compose service (+30 more)

### Community 5 - "Accordion & Dropdown Menu UI"
Cohesion: 0.12
Nodes (20): AccordionContent(), AccordionItem(), AccordionTrigger(), AccordionTriggerProps, DropdownMenu(), DropdownMenuCheckboxItem(), DropdownMenuContent(), DropdownMenuItem() (+12 more)

### Community 6 - "Internationalization (i18n) Locales"
Cohesion: 0.14
Nodes (21): languages, resources, ar, arLanguage, de, deLanguage, en, enLanguage (+13 more)

### Community 7 - "App Navigation Shell"
Cohesion: 0.10
Nodes (27): CommandMenu(), Header(), AppSidebar(), useSidebarData(), NavGroup(), Sidebar(), SidebarContent(), SidebarContext (+19 more)

### Community 8 - "UI Primitives (Alert/Avatar/Card)"
Cohesion: 0.11
Nodes (25): Alert(), AlertDescription(), AlertTitle(), alertVariants, Avatar(), AvatarFallback(), AvatarImage(), Card() (+17 more)

### Community 9 - "Database History & Relationship Model"
Cohesion: 0.16
Nodes (18): RelationshipAccordionContentProps, DatabaseType, RelationshipType, RenderableTable, SortableTable, toRenderableTable(), toSortableTable(), DatabaseHistoryContextType (+10 more)

### Community 10 - "ER Diagram Canvas Rendering"
Cohesion: 0.13
Nodes (21): DatabaseDiagram(), SqlPreview(), SqlPreviewProps, IndexItem(), Relationship(), RelationshipProps, useHighlightedEdges(), UseOverlapingType (+13 more)

### Community 11 - "SQL Import Data Model"
Cohesion: 0.17
Nodes (18): DatabaseDialect, DatabaseType, ImportDatabaseMethod, ImportDatabaseOption, ImportMethodType, DataTypes, TimeDefaultValues, FieldInsertType (+10 more)

### Community 12 - "TypeScript App Config"
Cohesion: 0.07
Nodes (26): DOM, DOM.Iterable, ES2022, src, compilerOptions, allowImportingTsExtensions, baseUrl, erasableSyntaxOnly (+18 more)

### Community 13 - "Sidebar Navigation Data"
Cohesion: 0.11
Nodes (22): checkIsActive(), SidebarMenuCollapsedDropdown(), SidebarMenuCollapsible(), SidebarMenuLink(), BaseNavItem, MenuItem, NavCollapsible, NavGroup (+14 more)

### Community 14 - "Field Editing & Renderer Props"
Cohesion: 0.12
Nodes (14): FieldDefaultValueProps, Props, Props, Props, IndexesListProps, Props, FieldType, PostgresqlRenderer (+6 more)

### Community 15 - "Form Input UI Controls"
Cohesion: 0.19
Nodes (16): DatePicker(), DatePickerProps, MultiSelect, Label, Select(), SelectContent(), SelectGroup(), SelectItem() (+8 more)

### Community 16 - "Button/Clipboard/Tooltip UI"
Cohesion: 0.26
Nodes (11): ClipboardProps, Button, Input, Tooltip(), TooltipContent(), TooltipTrigger(), DbControlButtons, CircularDependencyAlertProps (+3 more)

### Community 17 - "Database Modal & Provider Hooks"
Cohesion: 0.19
Nodes (16): useMenuData(), DatabaseControlButtons(), CreateDatabaseModal(), useDisclosure(), useDatabaseHistory(), DatabaseHotkeysContext, DatabaseHotkeysProvider(), Props (+8 more)

### Community 18 - "shadcn/ui Component Config"
Cohesion: 0.10
Nodes (19): aliases, components, hooks, lib, providers, ui, utils, iconLibrary (+11 more)

### Community 19 - "Field & Relationship Modals"
Cohesion: 0.16
Nodes (18): Combobox(), ModalProps, CircularDependencyAlert(), RelationshipAccordionContent(), RelationshipAccordionTrigger(), fieldDefautlValue(), FieldItem(), FieldSetting() (+10 more)

### Community 20 - "Per-Dialect Data Type Definitions"
Cohesion: 0.27
Nodes (10): MariaDbDataType, MSSQLDataType, MysqlDataType, OracleDataType, PostgresDataType, SqliteDataTypes, data_types, DataInsertType (+2 more)

### Community 21 - "MySQL/MariaDB Import & Render"
Cohesion: 0.16
Nodes (7): MySQLCharset, MySQLCollation, DataType, MariaDbImporter, MysqlImporter, MariaDbRenderer, MysqlRenderer

### Community 22 - "Form Widget UI (Badge/Calendar/Radio)"
Cohesion: 0.20
Nodes (12): InputTags, InputTagsProps, Badge(), badgeVariants, buttonVariants, Calendar(), CalendarDayButton(), RadioGroup() (+4 more)

### Community 23 - "Menu & Menubar UI"
Cohesion: 0.16
Nodes (14): Menu(), Menubar(), MenubarCheckboxItem(), MenubarContent(), MenubarItem(), MenubarLabel(), MenubarMenu(), MenubarRadioItem() (+6 more)

### Community 24 - "Database History & Diff Provider"
Cohesion: 0.19
Nodes (9): emptyDb(), DatabaseHistoryProvider(), Props, DBDiffOperation, mapDiffToDBDiffOperation(), normalizeDatabase(), BaseDatabaseRenderer, DBRenderOutput (+1 more)

### Community 25 - "Theme & Code Editor Providers"
Cohesion: 0.16
Nodes (13): CodeEditor(), CodeEditorProps, ThemeSwitch(), Toaster(), TooltipProvider(), UIProviders(), initialState, Theme (+5 more)

### Community 26 - "PowerSync Sync & Data Type Seeding"
Cohesion: 0.13
Nodes (11): mapToDataType(), seedDataTypes(), AppSchema, ConnectorContext, db, powerSyncDb, SyncProvider(), SyncProviderProps (+3 more)

### Community 27 - "Core Schema Type Definitions"
Cohesion: 0.37
Nodes (8): ForeignKeyActions, Modifiers, PostgreSQLCharset, PostgreSQLCollation, SQLiteCollation, databases, IndexType, Cardinality

### Community 28 - "NPM Runtime Dependencies"
Cohesion: 0.12
Nodes (17): clsx, date-fns, i18next-browser-languagedetector, object-hash, dependencies, clsx, date-fns, i18next-browser-languagedetector (+9 more)

### Community 29 - "Header & Toggle UI Components"
Cohesion: 0.17
Nodes (7): react, HeaderProps, ToggleGroupContext, ToggleGroupItem(), Toggle(), toggleVariants, IconSvgProps

### Community 30 - "SQL Import Parser Core"
Cohesion: 0.21
Nodes (3): randomColor(), BaseSqlImporter, SqliteImporter

### Community 31 - "List/Controller UI Components"
Cohesion: 0.26
Nodes (8): EmptyList(), EmptyListProps, Accordion(), ScrollArea(), Separator(), RelationshipController(), TablesController(), useDiagram()

### Community 32 - "NPM Dev Dependencies"
Cohesion: 0.15
Nodes (13): autoprefixer, eslint-plugin-node, eslint-plugin-unused-imports, devDependencies, autoprefixer, eslint-plugin-node, eslint-plugin-unused-imports, prettier (+5 more)

### Community 33 - "Drawer & Mobile Layout UI"
Cohesion: 0.18
Nodes (8): Drawer(), DrawerContent(), DrawerDescription(), DrawerFooter(), DrawerHeader(), DrawerOverlay(), DrawerTitle(), DatabaseMobileLayout()

### Community 34 - "Package Scripts & Metadata"
Cohesion: 0.17
Nodes (11): name, private, scripts, build, dev, lint, preview, test (+3 more)

### Community 36 - "Vite & Node TS Config"
Cohesion: 0.18
Nodes (10): vite.config.ts, vitest.config.ts, compilerOptions, allowSyntheticDefaultImports, composite, module, moduleResolution, skipLibCheck (+2 more)

### Community 37 - "App Routing"
Cohesion: 0.29
Nodes (7): App(), Dashboard(), NotFoundPage(), DiagramProvider(), useAppRoutes(), useDashboardRoutes(), useDatabaseRoutes()

### Community 38 - "Spinner Icon Components"
Cohesion: 0.18
Nodes (6): Circle(), CircleFilled(), Default(), Pinwheel(), SpinnerProps, SpinnerVariantProps

### Community 39 - "Sheet UI Component"
Cohesion: 0.18
Nodes (7): Sheet(), SheetContent(), SheetDescription(), SheetFooter(), SheetHeader(), SheetOverlay(), SheetTitle()

### Community 40 - "Diagram Cardinality & Context"
Cohesion: 0.27
Nodes (8): CardinalityMarker(), CardinalityMarkerProps, CardinalityStyle, DiagramDataContext, DiagramDataContextType, DiagramOpsContext, DiagramOpsContextType, Props

### Community 41 - "Table UI & Open Database Modal"
Cohesion: 0.33
Nodes (8): Table(), TableBody(), TableCaption(), TableCell(), TableFooter(), TableHead(), TableHeader(), TableRow()

### Community 42 - "Render/Data-Type Test Utilities"
Cohesion: 0.27
Nodes (9): getDataTypes(), buildSampleDatabase(), pick(), resolveTypes(), cases, render(), RenderCase, byName() (+1 more)

### Community 43 - "Database Layout & Loading Modal"
Cohesion: 0.28
Nodes (6): Loading(), LoadingProps, Spinner(), DatabaseDesktopLayout, DatabaseLayout(), DatabaseMobileLayout

### Community 44 - "Search Provider & UI"
Cohesion: 0.28
Nodes (7): Props, Search(), Props, SearchContext, SearchContextType, SearchProvider(), useSearch()

### Community 45 - "Field Model & Table Accordion"
Cohesion: 0.31
Nodes (6): TableAccordionContent(), TableAccordionHeader(), field(), cloneField(), getNextSequence(), cloneTable()

### Community 47 - "Font Provider"
Cohesion: 0.29
Nodes (5): fonts, Font, FontContext, FontContextType, FontProvider()

### Community 49 - "Root TypeScript Config"
Cohesion: 0.33
Nodes (5): compilerOptions, baseUrl, paths, files, references

### Community 50 - "SQLite Brand Assets"
Cohesion: 0.50
Nodes (4): SQL Dialect Selector Icon, SQLite Small Logo, SQLite, SQLite Logo

### Community 52 - "MariaDB Brand Assets"
Cohesion: 0.67
Nodes (3): MariaDB SQL Dialect, MariaDB Logo, MariaDB Small Logo

## Knowledge Gaps
- **308 isolated node(s):** `$schema`, `browser`, `es2021`, `node`, `plugin:react/recommended` (+303 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **97 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `react` connect `Header & Toggle UI Components` to `Core UI Primitives (Picker/Combobox/Modal)`, `ESLint Configuration`, `Database Schema & Field Model`, `Accordion & Dropdown Menu UI`, `App Navigation Shell`, `UI Primitives (Alert/Avatar/Card)`, `Database History & Relationship Model`, `ER Diagram Canvas Rendering`, `Sidebar Navigation Data`, `Form Input UI Controls`, `Button/Clipboard/Tooltip UI`, `Database Modal & Provider Hooks`, `Field & Relationship Modals`, `Form Widget UI (Badge/Calendar/Radio)`, `Menu & Menubar UI`, `Database History & Diff Provider`, `Theme & Code Editor Providers`, `PowerSync Sync & Data Type Seeding`, `List/Controller UI Components`, `Drawer & Mobile Layout UI`, `Sheet UI Component`, `Diagram Cardinality & Context`, `Table UI & Open Database Modal`, `Database Layout & Loading Modal`, `Search Provider & UI`, `Font Provider`?**
  _High betweenness centrality (0.126) - this node is a cross-community bridge._
- **Why does `cn()` connect `UI Primitives (Alert/Avatar/Card)` to `Core UI Primitives (Picker/Combobox/Modal)`, `Accordion & Dropdown Menu UI`, `App Navigation Shell`, `ER Diagram Canvas Rendering`, `Sidebar Navigation Data`, `Form Input UI Controls`, `Button/Clipboard/Tooltip UI`, `Database Modal & Provider Hooks`, `Field & Relationship Modals`, `Form Widget UI (Badge/Calendar/Radio)`, `Menu & Menubar UI`, `Theme & Code Editor Providers`, `Header & Toggle UI Components`, `List/Controller UI Components`, `Drawer & Mobile Layout UI`, `Spinner Icon Components`, `Sheet UI Component`, `Diagram Cardinality & Context`, `Table UI & Open Database Modal`, `Search Provider & UI`?**
  _High betweenness centrality (0.097) - this node is a cross-community bridge._
- **Why does `dependencies` connect `NPM Runtime Dependencies` to `Package Scripts & Metadata`, `class-variance-authority Dependency`, `cmdk Command Palette Dependency`, `CodeMirror SQL Language Dependency`, `dayjs Date Dependency`, `dnd-kit Core Drag/Drop Dependency`, `dnd-kit Sortable Dependency`, `Drizzle ORM Dependency`, `elkjs Layout Dependency`, `fast-json-patch Dependency`, `framer-motion Animation Dependency`, `sqlparser-ts Dependency`, `internationalized/date Dependency`, `lodash Utility Dependency`, `lucide-react Icons Dependency`, `nextui-org/react Dependency`, `node-sql-parser Dependency`, `pgsql-ast-parser Dependency`, `pluralize Dependency`, `PowerSync Drizzle Driver Dependency`, `PowerSync React Dependency`, `Radix Accordion Dependency`, `Radix Avatar Dependency`, `Radix Collapsible Dependency`, `Radix Dialog Dependency`, `Radix Dropdown Menu Dependency`, `Radix Label Dependency`, `Radix Popover Dependency`, `Radix Radio Group Dependency`, `Radix Select Dependency`, `Radix Separator Dependency`, `Radix Slot Dependency`, `Radix Switch Dependency`, `Radix Toggle Dependency`, `Radix Tooltip Dependency`, `React Core Dependency`, `react-aria Visually Hidden Dependency`, `react-day-picker Dependency`, `react-dom Dependency`, `react-i18next Dependency`, `react-resizable-panels Dependency`, `react-router-dom Dependency`, `react-tag-input Dependency`, `react-types/shared Dependency`, `react-use-hotkeys Dependency`, `sonner Toast Dependency`, `sql-formatter Dependency`, `tabler-icons Dependency`, `tailwind-merge Dependency`, `tailwind-variants Dependency`, `Tailwind CSS Dependency`, `tailwindcss-animate Dependency`, `Tailwind Typography Plugin Dependency`, `Tailwind Vite Plugin Dependency`, `uiw/react-codemirror Dependency`, `use-undo Dependency`, `uuid Dependency`, `vaul Drawer Dependency`, `xyflow/react Diagram Dependency`?**
  _High betweenness centrality (0.031) - this node is a cross-community bridge._
- **What connects `$schema`, `browser`, `es2021` to the rest of the system?**
  _308 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Core UI Primitives (Picker/Combobox/Modal)` be split into smaller, more focused modules?**
  _Cohesion score 0.09898989898989899 - nodes in this community are weakly interconnected._
- **Should `ESLint Configuration` be split into smaller, more focused modules?**
  _Cohesion score 0.048625792811839326 - nodes in this community are weakly interconnected._
- **Should `Database Schema & Field Model` be split into smaller, more focused modules?**
  _Cohesion score 0.12292358803986711 - nodes in this community are weakly interconnected._