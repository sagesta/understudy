'use strict';
// Architecture files: Mermaid, PlantUML, C4, Graphviz, draw.io, Excalidraw, AsciiDoc and reST are read
// into plain statements ("A -> B: label") so a question put in words finds them.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const { diagramKind, diagramToMarkdown, convertDiagram, describeFences } = require('../src/main/knowledge/diagrams');
const { chunkMarkdown } = require('../src/main/knowledge/chunker');
const { Library } = require('../src/main/knowledge/library');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'understudy-diagrams-'));
const lines = (md) => md.split('\n');
const has = (md, line) => assert.ok(lines(md).includes(line), `missing line: ${line}\n--- got ---\n${md.split('## Source')[0]}`);
const lacks = (md, line) => assert.ok(!lines(md).includes(line), `unexpected line: ${line}`);
const conv = (src, kind, name = 'arch') => diagramToMarkdown(src, kind, { name });

test('file names map to diagram kinds, including the double extension', () => {
  const k = {
    'a.mmd': 'mermaid', 'a.MERMAID': 'mermaid', 'a.puml': 'plantuml', 'a.plantuml': 'plantuml', 'a.pu': 'plantuml', 'a.iuml': 'plantuml',
    'a.dsl': 'structurizr', 'a.dot': 'graphviz', 'a.gv': 'graphviz', 'a.drawio': 'drawio', 'a.drawio.xml': 'drawio',
    'a.excalidraw': 'excalidraw', 'a.adoc': 'asciidoc', 'a.asciidoc': 'asciidoc', 'a.rst': 'rst',
  };
  for (const [name, kind] of Object.entries(k)) assert.equal(diagramKind(name), kind, name);
  for (const name of ['a.xml', 'a.md', 'a.txt', 'a.png', 'drawio', 'a.vsdx', 'a.tf']) assert.equal(diagramKind(name), null, name);
});

test('Mermaid flowchart: shapes, labelled edges, chains, lists and subgraphs', () => {
  const md = conv(`flowchart LR
  subgraph Backend [Backend services]
    API[API Gateway] -->|REST| PAY(Payment Service)
    PAY --> DB[(Ledger DB)]
    PAY -- charges card --> STRIPE{{Stripe}}
  end
  User((Customer)) --> API & Web
  Web -.-> API
  A --> B --> C
  Q -- text --- R
  K<-->L
  %% a comment
  classDef x fill:#fff
  click A callback
`, 'mermaid', 'pay-flow');
  assert.match(md, /^# pay-flow\n\nArchitecture diagram \(Mermaid flowchart\)\./);
  has(md, '- API Gateway -> Payment Service: REST');
  has(md, '- Payment Service -> Ledger DB');
  has(md, '- Payment Service -> Stripe: charges card');
  has(md, '- Customer -> API Gateway');
  has(md, '- Customer -> Web');
  has(md, '- Web -> API Gateway');
  has(md, '- A -> B');
  has(md, '- B -> C');
  has(md, '- Q -- R: text');
  has(md, '- K <-> L');
  has(md, '- Ledger DB (database, in Backend services)');
  has(md, '- Payment Service (in Backend services)');
  assert.match(md, /## Source\n\n```mermaid\nflowchart LR/);
});

test('Mermaid flowchart: header statement, quoted labels, html and new shape syntax', () => {
  const md = conv(`graph TD; A["Order <b>Service</b>"] --> B@{ shape: cyl, label: "Orders DB" };
  B --> C[Billing &amp; Tax]`, 'mermaid');
  has(md, '- Order Service -> Orders DB');
  has(md, '- Orders DB -> Billing & Tax');
});

test('Mermaid sequence diagram: participants with aliases and message variants', () => {
  const md = conv(`sequenceDiagram
  participant U as User
  actor A as Admin
  U->>API: login
  API-->>U: token
  API->>+Auth: validate token
  Auth-)Audit: log it
  Note over API,Auth: ignored
  loop every minute
    API->>API: refresh
  end`, 'mermaid');
  has(md, '- User -> API: login');
  has(md, '- API -> User: token');
  has(md, '- API -> Auth: validate token');
  has(md, '- Auth -> Audit: log it');
  has(md, '- API -> API: refresh');
  has(md, '- Admin (actor)');
  has(md, '- User (participant)');
});

test('Mermaid class, ER and state diagrams', () => {
  const cls = conv(`classDiagram
  Animal <|-- Duck
  Order *-- LineItem
  Cart "1" --> "many" Item : holds
  Service ..> Repo
  class Foo {
    +bar()
  }`, 'mermaid');
  has(cls, '- Duck -> Animal: inherits from');
  has(cls, '- Order -> LineItem: is composed of');
  has(cls, '- Cart -> Item: holds');
  has(cls, '- Service -> Repo: depends on');
  const er = conv(`erDiagram
  CUSTOMER ||--o{ ORDER : places
  ORDER {
    int id
  }`, 'mermaid');
  has(er, '- CUSTOMER -> ORDER: places (exactly one CUSTOMER, zero or more ORDER)');
  const st = conv(`stateDiagram-v2
  [*] --> Idle
  Idle --> Running : start
  Running --> [*]`, 'mermaid');
  has(st, '- Start -> Idle');
  has(st, '- Idle -> Running: start');
  has(st, '- Running -> End');
});

test('Mermaid C4 macros and other Mermaid types', () => {
  const md = conv(`C4Container
  title Shop
  Person(customer, "Customer", "Buys things")
  System_Boundary(shop, "Shop") {
    Container(web, "Web app", "React", "The UI")
    ContainerDb(db, "Database", "Postgres")
  }
  Rel(customer, web, "Uses", "HTTPS")
  Rel(web, db, "Reads and writes", "SQL")`, 'mermaid');
  has(md, '- Customer (person): Buys things');
  has(md, '- Web app (container, React, in Shop): The UI');
  has(md, '- Customer -> Web app: Uses (HTTPS)');
  has(md, '- Web app -> Database: Reads and writes (SQL)');
  const pie = conv('pie title Pets\n  "Dogs" : 386\n', 'mermaid');
  assert.match(pie, /Architecture diagram \(Mermaid diagram\)/);
  assert.ok(!pie.includes('## Connections'));
  assert.match(pie, /## Source/);
});

test('PlantUML components, sequence arrows with styles, and class relations', () => {
  const md = conv(`@startuml
title Pay
package "Backend" {
  component "Payment Service" as pay <<Spring Boot>>
  database "Ledger DB" as ledger
}
[Web App] --> pay : HTTPS
pay ..> ledger : writes
pay -[#red]-> [Stripe] : charge
actor User
User -> [Web App]
Alice <- Bob : hi
Foo *-- Bar
Child --|> Parent
note right of pay : ignored
@enduml`, 'plantuml', 'pu');
  has(md, '- Payment Service (component, Spring Boot, in Backend)');
  has(md, '- Ledger DB (database, in Backend)');
  has(md, '- Web App -> Payment Service: HTTPS');
  has(md, '- Payment Service -> Ledger DB: writes');
  has(md, '- Payment Service -> Stripe: charge');
  has(md, '- User -> Web App');
  has(md, '- Bob -> Alice: hi');
  has(md, '- Foo -> Bar: contains');
  has(md, '- Child -> Parent: inherits from');
  assert.match(md, /Architecture diagram \(PlantUML\)/);
});

test('PlantUML sequence diagram with quoted participants and C4 macros', () => {
  const seq = conv(`@startuml
participant "Mobile App" as app
participant "Auth Service" as auth
app -> auth : POST /login
auth --> app : token
app ->> "Order API" : create order
@enduml`, 'plantuml');
  has(seq, '- Mobile App -> Auth Service: POST /login');
  has(seq, '- Auth Service -> Mobile App: token');
  has(seq, '- Mobile App -> Order API: create order');
  const c4 = conv(`@startuml
!include C4_Container.puml
Person(user, "Customer", "Buys things")
System_Boundary(sb, "Shop") {
  Container(web, "Web app", "React", "UI")
  ContainerDb(db, "Database", "Postgres", "Stores orders")
}
System_Ext(stripe, "Stripe", "Takes payments")
Rel(user, web, "Uses", "HTTPS")
Rel_D(web, db, "Reads from", "SQL")
BiRel(web, stripe, "Pays via")
Rel_Back(db, web, "Serves")
@enduml`, 'plantuml');
  assert.match(c4, /PlantUML C4 model/);
  has(c4, '- Customer (person): Buys things');
  has(c4, '- Database (container database, Postgres, in Shop): Stores orders');
  has(c4, '- Stripe (external software system): Takes payments');
  has(c4, '- Customer -> Web app: Uses (HTTPS)');
  has(c4, '- Web app -> Database: Reads from (SQL)');
  has(c4, '- Web app <-> Stripe: Pays via');
  has(c4, '- Web app -> Database: Serves');
});

test('a Markdown file with a diagram fence gains its connection list; other files are returned untouched', () => {
  const md = '# Design\n\nIntro text.\n\n```mermaid\ngraph TD\n  A[Auth] --> B[Users]\n  B --> C\n```\n\nAfter.\n\n```js\nconst x = 1;\n```\n';
  const out = describeFences(md);
  assert.ok(out.startsWith(md.slice(0, md.indexOf('After.'))), 'the original text is kept in place');
  assert.ok(out.endsWith('After.\n\n```js\nconst x = 1;\n```\n'));
  has(out, '- Auth -> Users');
  has(out, '- Users -> C');
  has(out, '- Auth');
  assert.ok(out.indexOf('Connections in the') > out.indexOf('A[Auth]'), 'the list follows the fence');
  const plainMd = '# Notes\n\nNothing to see.\n\n```js\nconst a = 1;\n```\n'.repeat(3);
  assert.strictEqual(describeFences(plainMd), plainMd);
  // a diagram fence inside another fence is not a diagram
  const nested = '````md\n```mermaid\nA --> B\n```\n````\n';
  assert.strictEqual(describeFences(nested), nested);
  // an unclosed fence is left alone and does not throw
  const open = '# T\n\n```mermaid\nA --> B\n';
  assert.strictEqual(describeFences(open), open);
});

test('Structurizr DSL: elements, nesting, relationships and views that are skipped', () => {
  const md = conv(`workspace "Shop" "An online shop" {
  model {
    customer = person "Customer" "Buys things"
    shop = softwareSystem "Online Shop" "Sells things" {
      web = container "Web App" "Serves the UI" "React"
      api = container "Payment Service" "Takes card payments" "Node.js" {
        ledger = component "Ledger Client" "Writes entries" "JDBC"
      }
      db = container "Ledger DB" "Stores transactions" "Postgres"
      group "Data" {
        cache = container "Cache" "Hot data" "Redis"
      }
    }
    stripe = softwareSystem "Stripe" "Card processor" "External"
    customer -> web "Browses" "HTTPS"
    web -> api "Calls" "REST"
    api -> db "Writes transactions" "JDBC"
    api -> stripe "Charges cards"
    api -> cache
  }
  views {
    container shop "Containers" {
      include *
      autoLayout
    }
    styles {
      element "Person" {
        shape person
      }
    }
  }
}`, 'structurizr', 'shop');
  assert.match(md, /Architecture diagram \(C4 model \(Structurizr\)\)\./);
  has(md, '- Customer (person): Buys things');
  has(md, '- Online Shop (software system): Sells things');
  has(md, '- Payment Service (container, Node.js, in Online Shop): Takes card payments');
  has(md, '- Ledger Client (component, JDBC, in Online Shop > Payment Service): Writes entries');
  has(md, '- Cache (container, Redis, in Online Shop > Data): Hot data');
  has(md, '- Customer -> Web App: Browses (HTTPS)');
  has(md, '- Payment Service -> Ledger DB: Writes transactions (JDBC)');
  has(md, '- Payment Service -> Stripe: Charges cards');
  has(md, '- Payment Service -> Cache');
  lacks(md, '- Containers (container)');
  const h = conv(`workspace {
  !identifiers hierarchical
  model {
    ss = softwareSystem "Billing" {
      api = container "Billing API"
      db = container "Billing DB"
      api -> db "reads and writes"
    }
    ss.api -> ss.db "audit"
  }
}`, 'structurizr');
  has(h, '- Billing API -> Billing DB: reads and writes');
  has(h, '- Billing API -> Billing DB: audit');
});

test('Graphviz: labels, edge labels, clusters, undirected graphs, attribute direction', () => {
  const md = conv(`digraph arch {
  rankdir=LR;
  node [shape=box];
  subgraph cluster_backend {
    label = "Backend";
    api [label="API Gateway"];
    pay [label="Payment Service"];
    db [label="Ledger DB", shape=cylinder];
  }
  user -> api [label="HTTPS"];
  api -> pay -> db [label="calls"];
  pay -> {stripe email};
  db -> pay [dir=back, label="restore"];
  // comment
  /* block */
}`, 'graphviz', 'g');
  has(md, '- API Gateway (in Backend)');
  has(md, '- Ledger DB (database, in Backend)');
  has(md, '- user -> API Gateway: HTTPS');
  has(md, '- API Gateway -> Payment Service: calls');
  has(md, '- Payment Service -> Ledger DB: calls');
  has(md, '- Payment Service -> stripe');
  has(md, '- Payment Service -> email');
  has(md, '- Payment Service -> Ledger DB: restore');
  const u = conv('graph g { a -- b [label="link"]; b -- c; }', 'graphviz');
  has(u, '- a -- b: link');
  has(u, '- b -- c');
  const html = conv('digraph { a [label=<<b>Auth</b> &amp; Users>]; a -> b }', 'graphviz');
  has(html, '- Auth & Users -> b');
});

test('Markdown fences: Structurizr, Graphviz and PlantUML fences are described too', () => {
  const md = [
    '# Fences', '', '```dot', 'digraph { a [label="Auth"]; a -> b }', '```', '',
    '```puml', '[Web] --> [API] : calls', '```', '',
    '```structurizr', 'a = container "Alpha"', 'b = container "Beta"', 'a -> b "talks to"', '```', '',
  ].join('\n');
  const out = describeFences(md);
  has(out, '- Auth -> b');
  has(out, '- Web -> API: calls');
  has(out, '- Alpha -> Beta: talks to');
});

// ---- draw.io -------------------------------------------------------------------------------------

const DRAWIO_MODEL = `<mxGraphModel dx="1000" dy="600"><root>
<mxCell id="0"/><mxCell id="1" parent="0"/>
<mxCell id="vpc" value="Production VPC" style="swimlane;html=1;" vertex="1" parent="1"><mxGeometry as="geometry"/></mxCell>
<mxCell id="web" value="&lt;b&gt;Web&lt;/b&gt; App&lt;br&gt;(React)" style="rounded=1;html=1;" vertex="1" parent="vpc"><mxGeometry as="geometry"/></mxCell>
<object label="Payment Service" id="pay" tooltip="takes payments"><mxCell style="rounded=0;" vertex="1" parent="vpc"><mxGeometry as="geometry"/></mxCell></object>
<mxCell id="db" value="Ledger &amp;amp; Audit DB" style="shape=cylinder3;whiteSpace=wrap;html=1;" vertex="1" parent="vpc"><mxGeometry as="geometry"/></mxCell>
<mxCell id="ext" value="Stripe" style="shape=cloud;html=1;" vertex="1" parent="1"><mxGeometry as="geometry"/></mxCell>
<mxCell id="e1" value="HTTPS" style="edgeStyle=orthogonalEdgeStyle;html=1;" edge="1" parent="1" source="web" target="pay"><mxGeometry relative="1" as="geometry"/></mxCell>
<mxCell id="e2" style="endArrow=classic;startArrow=classic;html=1;" edge="1" parent="1" source="pay" target="db"><mxGeometry relative="1" as="geometry"/></mxCell>
<mxCell id="e2l" value="reads and writes" style="edgeLabel;html=1;" vertex="1" connectable="0" parent="e2"><mxGeometry relative="1" as="geometry"/></mxCell>
<mxCell id="e3" value="charge" style="endArrow=none;html=1;" edge="1" parent="1" source="pay" target="ext"><mxGeometry relative="1" as="geometry"/></mxCell>
<mxCell id="e4" value="dangling" edge="1" parent="1" source="pay"><mxGeometry relative="1" as="geometry"/></mxCell>
</root></mxGraphModel>`;
const drawioPlain = (pages) => `<?xml version="1.0" encoding="UTF-8"?>\n<mxfile host="app.diagrams.net">${pages.map(([name, model]) => `<diagram id="${name}" name="${name}">${model}</diagram>`).join('')}</mxfile>`;
const deflateB64 = (xml) => zlib.deflateRawSync(Buffer.from(encodeURIComponent(xml), 'utf8')).toString('base64');

test('draw.io: shapes, groups, edge labels, arrow direction; labels are cleaned of HTML', () => {
  const md = conv(drawioPlain([['Page-1', DRAWIO_MODEL]]), 'drawio', 'shop');
  assert.match(md, /Architecture diagram \(draw\.io\)\./);
  has(md, '- Production VPC (group)');
  has(md, '- Web App (React) (in Production VPC)');
  has(md, '- Payment Service (in Production VPC)');
  has(md, '- Ledger & Audit DB (database, in Production VPC)');
  has(md, '- Stripe (cloud)');
  has(md, '- Web App (React) -> Payment Service: HTTPS');
  has(md, '- Payment Service <-> Ledger & Audit DB: reads and writes');
  has(md, '- Payment Service -- Stripe: charge');
  assert.ok(!md.includes('dangling'), 'an edge with no far end is left out');
  assert.ok(!md.includes('## Source'), 'the raw XML is not kept');
});

test('draw.io: a compressed page gives the same result as the plain one; several pages get a section each', () => {
  const plain = conv(drawioPlain([['Page-1', DRAWIO_MODEL]]), 'drawio', 'shop');
  const packed = conv(drawioPlain([['Page-1', deflateB64(DRAWIO_MODEL)]]), 'drawio', 'shop');
  assert.equal(packed, plain);
  const pages = conv(drawioPlain([['Context', DRAWIO_MODEL], ['Deployment', deflateB64('<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="a" value="Load Balancer" vertex="1" parent="1"/><mxCell id="b" value="App Server" vertex="1" parent="1"/><mxCell id="e" edge="1" parent="1" source="a" target="b"/></root></mxGraphModel>')]]), 'drawio', 'multi');
  assert.match(pages, /\n## Context\n/);
  assert.match(pages, /\n## Deployment\n/);
  has(pages, '- Load Balancer -> App Server');
  has(pages, '- Web App (React) -> Payment Service: HTTPS');
  // a bare model with no <mxfile> wrapper, and the double extension through the library path
  assert.match(conv(DRAWIO_MODEL, 'drawio'), /Payment Service/);
});

// ---- Excalidraw ----------------------------------------------------------------------------------

test('Excalidraw: bound text labels shapes and arrows, arrows join shapes, loose text is listed as notes', () => {
  const box = (id, extra = {}) => ({ id, type: 'rectangle', x: 0, y: 0, width: 100, height: 50, isDeleted: false, ...extra });
  const txt = (id, text, extra = {}) => ({ id, type: 'text', text, originalText: text, x: 0, y: 0, isDeleted: false, ...extra });
  const doc = {
    type: 'excalidraw', version: 2, source: 'https://excalidraw.com',
    elements: [
      box('api'), txt('t-api', 'API Gateway', { containerId: 'api' }),
      box('pay', { frameId: 'f1' }), txt('t-pay', 'Payment\nService', { containerId: 'pay' }),
      { id: 'f1', type: 'frame', name: 'Backend', isDeleted: false },
      { id: 'db', type: 'ellipse', isDeleted: false }, txt('t-db', 'Ledger DB', { containerId: 'db' }),
      { id: 'gone', type: 'rectangle', isDeleted: true }, txt('t-gone', 'Deleted Thing', { containerId: 'gone', isDeleted: true }),
      { id: 'a1', type: 'arrow', startBinding: { elementId: 'api' }, endBinding: { elementId: 'pay' }, endArrowhead: 'arrow', startArrowhead: null, isDeleted: false },
      txt('t-a1', 'REST', { containerId: 'a1' }),
      { id: 'a2', type: 'arrow', startBinding: { elementId: 'pay' }, endBinding: { elementId: 'db' }, endArrowhead: 'arrow', startArrowhead: 'arrow', isDeleted: false },
      { id: 'a3', type: 'arrow', startBinding: { elementId: 'db' }, endBinding: { elementId: 'pay' }, endArrowhead: null, startArrowhead: null, isDeleted: false },
      { id: 'a4', type: 'arrow', startBinding: null, endBinding: { elementId: 'db' }, endArrowhead: 'arrow', isDeleted: false },
      txt('free', 'Draft: review in March'),
    ],
  };
  const md = conv(JSON.stringify(doc), 'excalidraw', 'sketch');
  assert.match(md, /Architecture diagram \(Excalidraw\)\./);
  has(md, '- API Gateway');
  has(md, '- Payment Service (in Backend)');
  has(md, '- Ledger DB');
  has(md, '- API Gateway -> Payment Service: REST');
  has(md, '- Payment Service <-> Ledger DB');
  has(md, '- Ledger DB -- Payment Service');
  has(md, '- Draft: review in March');
  assert.match(md, /## Notes\n- Draft: review in March/);
  assert.ok(!md.includes('Deleted Thing'));
  assert.ok(!md.includes('## Source'));
});

// ---- AsciiDoc and reStructuredText ---------------------------------------------------------------

test('AsciiDoc: headings become Markdown headings, diagram blocks get their connection lists', () => {
  const adoc = [
    '= Architecture', ':toc:', '', '== Context and scope', '', 'The shop talks to a card processor.', '',
    '[plantuml, format=svg]', '----', '[Shop] --> [Stripe] : charges', '# not a heading', '----', '',
    '=== Building blocks', '', '[source,java]', '----', '// == not a heading either', 'class A {}', '----', '',
    '[mermaid]', '----', 'graph LR', '  W[Web] --> A[API]', '----', '',
  ].join('\n');
  const md = conv(adoc, 'asciidoc');
  assert.match(md, /^# Architecture$/m);
  assert.match(md, /^## Context and scope$/m);
  assert.match(md, /^### Building blocks$/m);
  has(md, '- Shop -> Stripe: charges');
  has(md, '- Web -> API');
  const chunks = chunkMarkdown(md);
  const hit = chunks.find((c) => c.text.includes('- Shop -> Stripe: charges'));
  assert.deepEqual(hit.headings, ['Architecture', 'Context and scope']);
  assert.ok(chunks.every((c) => !/^# not a heading/m.test(c.text.replace(/```[\s\S]*?```/g, ''))), 'code inside a block is not read as a heading');
  assert.ok(md.includes('// == not a heading either'));
});

test('reStructuredText: underlined and over/underlined titles, and diagram directives', () => {
  const rst = [
    '=============', 'Architecture', '=============', '', 'Intro paragraph.', '',
    'Context', '=======', '', 'Some text.', '',
    'Building blocks', '---------------', '',
    '.. uml::', '   :caption: context', '', '   [Shop] --> [Stripe] : charges', '',
    '.. code-block:: python', '', '   # a comment, not a heading', '   print(1)', '',
    'Runtime', '=======', '', 'More text.', '',
  ].join('\n');
  const md = conv(rst, 'rst');
  assert.match(md, /^# Architecture$/m);
  assert.match(md, /^## Context$/m);
  assert.match(md, /^### Building blocks$/m);
  assert.match(md, /^## Runtime$/m);
  has(md, '- Shop -> Stripe: charges');
  assert.ok(md.includes('# a comment, not a heading'));
  const chunks = chunkMarkdown(md);
  assert.deepEqual(chunks.find((c) => c.text.includes('- Shop -> Stripe')).headings, ['Architecture', 'Context', 'Building blocks']);
  assert.ok(!chunks.some((c) => c.headings.includes('a comment, not a heading')));
});

// ---- chunking, safety, and the library -----------------------------------------------------------

test('a 300-node diagram cut into passages still yields self-contained connection lines', () => {
  const edges = [];
  for (let i = 1; i < 300; i++) edges.push(`  N${i}[Service ${i}] -->|calls ${i}| N${i + 1}[Service ${i + 1}]`);
  const md = conv(`flowchart TD\n${edges.join('\n')}\n`, 'mermaid', 'big-system');
  const chunks = chunkMarkdown(md);
  assert.ok(chunks.length > 8, `only ${chunks.length} passages`);
  const connection = chunks.filter((c) => c.headings.includes('Connections'));
  assert.ok(connection.length > 3, 'the connection list is spread over several passages');
  const seen = new Set();
  for (const c of connection) {
    assert.deepEqual(c.headings, ['big-system', 'Connections']);
    for (const line of c.text.split('\n').filter((l) => l && !/^What each part talks to/.test(l))) {
      assert.match(line, /^- Service \d+ -> Service \d+: calls \d+$/, 'every line names both ends');
      seen.add(line);
    }
  }
  assert.equal(seen.size, 299);
  // the same through a Markdown fence
  const fenced = describeFences(`# Big\n\n\`\`\`mermaid\nflowchart TD\n${edges.join('\n')}\n\`\`\`\n`);
  assert.ok(fenced.includes('- Service 150 -> Service 151: calls 150'));
});

test('untrusted input: garbage, truncated XML and JSON, and very long lines never throw or hang', () => {
  const t0 = Date.now();
  const junk = ['', '\u0000\u0001\u0002', 'A --> ', '-->'.repeat(30000), '[' + '('.repeat(50000), 'a'.repeat(300000), '"'.repeat(5000), '{'.repeat(20000), '<'.repeat(20000),
    `A${' '.repeat(100000)}-->B`, '-- '.repeat(40000) + '-->', 'graph TD\n' + 'A-->B-->'.repeat(20000), '@startuml\n' + '[a] -[#'.repeat(20000), '"x" '.repeat(30000) + '->'];
  const kinds = ['mermaid', 'plantuml', 'structurizr', 'graphviz', 'drawio', 'excalidraw', 'asciidoc', 'rst'];
  for (const kind of kinds) {
    for (const src of junk) {
      let r;
      assert.doesNotThrow(() => { r = convertDiagram(src, kind, { name: 'x' }); }, `${kind} threw`);
      assert.ok(typeof r.markdown === 'string' || typeof r.reason === 'string', `${kind} gave neither text nor a reason`);
      assert.doesNotThrow(() => describeFences('```' + kind + '\n' + src + '\n```\n'));
    }
  }
  // text kinds fall back to plain text with the source; XML and JSON kinds say why
  assert.match(convertDiagram('graph ???', 'mermaid').markdown, /## Source/);
  assert.match(convertDiagram('<mxfile><diagram name="a">%%%not base64 or xml%%%</diagram></mxfile>', 'drawio').reason, /could not be read as draw\.io/);
  assert.match(convertDiagram('<mxfile><diagram', 'drawio').reason, /could not be read as draw\.io/);
  assert.match(convertDiagram('{"elements": [ {"id": "a"', 'excalidraw').reason, /could not be read as Excalidraw/);
  assert.match(convertDiagram('{"nothing": true}', 'excalidraw').reason, /could not be read as Excalidraw/);
  assert.match(convertDiagram('[1,2,3]', 'excalidraw').reason, /could not be read as Excalidraw/);
  const truncated = drawioPlain([['P', DRAWIO_MODEL]]).slice(0, 700);
  assert.doesNotThrow(() => convertDiagram(truncated, 'drawio'));
  assert.ok(Date.now() - t0 < 15000, `took ${Date.now() - t0} ms`);
});

test('a deflate bomb inside a draw.io file is refused, not inflated', () => {
  const bomb = zlib.deflateRawSync(Buffer.alloc(150 * 1024 * 1024, 0x61), { level: 9 }).toString('base64');
  assert.ok(bomb.length < 1024 * 1024, 'the file itself is small');
  const t0 = Date.now();
  const r = convertDiagram(`<mxfile><diagram name="x">${bomb}</diagram></mxfile>`, 'drawio');
  assert.ok(r.reason && /larger than 64 MB|compressed page/.test(r.reason), JSON.stringify(r).slice(0, 200));
  assert.ok(Date.now() - t0 < 10000, `took ${Date.now() - t0} ms`);
  // a file over the size limit is left out with a reason, without being parsed
  const big = convertDiagram(' '.repeat(33 * 1024 * 1024), 'excalidraw');
  assert.match(big.reason, /larger than 32 MB/);
});

test('the library reads one file of each kind and puts the right diagram on top for a question in words', async () => {
  const dir = tmp();
  const w = (name, body) => { fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true }); fs.writeFileSync(path.join(dir, name), body); };
  w('arch/payment-flow.mmd', 'flowchart LR\n  API[API Gateway] -->|REST| PAY(Payment Service)\n  PAY -->|writes transactions| DB[(Ledger DB)]\n  PAY -->|charges cards| STRIPE[Stripe]\n');
  w('arch/identity.puml', '@startuml\n[Browser] --> [Auth Service] : login\n[Auth Service] --> [Session Store] : stores sessions\n@enduml\n');
  w('arch/shop.dsl', 'workspace {\n model {\n  inv = softwareSystem "Inventory Manager" "Tracks stock" {\n   sync = container "Stock Sync" "Pushes counts" "Kafka"\n  }\n  wh = softwareSystem "Warehouse Robots"\n  inv -> wh "sends pick lists"\n }\n views {\n  systemContext inv { include * }\n }\n}\n');
  w('arch/network.dot', 'digraph net { edge_proxy [label="Edge Proxy"]; cdn [label="Content Cache"]; edge_proxy -> cdn [label="serves static assets"]; }\n');
  w('arch/billing.drawio', drawioPlain([['Page-1', deflateB64('<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="a" value="Invoice Engine" vertex="1" parent="1"/><mxCell id="b" value="Tax Calculator" vertex="1" parent="1"/><mxCell id="e" value="asks for rates" edge="1" parent="1" source="a" target="b"/></root></mxGraphModel>')]]));
  w('arch/legacy.drawio.xml', drawioPlain([['Page-1', '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="a" value="Mainframe Batch" vertex="1" parent="1"/><mxCell id="b" value="Nightly Export" vertex="1" parent="1"/><mxCell id="e" edge="1" parent="1" source="a" target="b"/></root></mxGraphModel>']]));
  w('arch/mobile.excalidraw', JSON.stringify({ type: 'excalidraw', elements: [
    { id: 'a', type: 'rectangle' }, { id: 'ta', type: 'text', text: 'Mobile Client', containerId: 'a' },
    { id: 'b', type: 'rectangle' }, { id: 'tb', type: 'text', text: 'Push Gateway', containerId: 'b' },
    { id: 'x', type: 'arrow', startBinding: { elementId: 'a' }, endBinding: { elementId: 'b' }, endArrowhead: 'arrow' }] }));
  w('docs/arc42.adoc', '= Shop\n\n== Solution strategy\n\nWe use a modular monolith.\n\n== Building block view\n\n[plantuml]\n----\n[Checkout Module] --> [Pricing Module] : asks for discounts\n----\n');
  w('docs/runtime.rst', 'Runtime view\n============\n\nOrders are placed through the checkout module.\n');
  w('notes/design.md', '# Search design\n\nThe search service is in front of the index.\n\n```mermaid\nsequenceDiagram\n  participant Q as Query Router\n  Q->>Shards: fan out\n  Shards-->>Q: partial results\n```\n');
  w('notes/payments-overview.md', '# Payments overview\n\nThe payments team meets weekly. Service levels are reviewed every month and we talk about incidents then. The roadmap for next quarter is in the planning document, and the team handbook explains how to join.\n');
  w('notes/lunch.md', '# Lunch\n\nThe canteen is closed on Fridays.\n');
  w('notes/ignored.xml', '<a><b>Mainframe Batch</b></a>');
  w('notes/secret.mmd', 'graph LR\n  A[Vault Client] --> B[Token Store]\n  %% ghp_abcdefghijklmnopqrstuvwxyz0123456789\n');
  w('arch/broken.drawio', '<mxfile><diagram name="a">%%%</diagram></mxfile>');

  const lib = new Library();
  const stats = await lib.reindex([{ dir, label: 'work', kind: 'work' }]);
  assert.equal(stats.files, 13, JSON.stringify(stats.skipped));
  assert.ok(stats.skipped.some((s) => /broken\.drawio$/.test(s.file) && /could not be read as draw\.io/.test(s.reason)), JSON.stringify(stats.skipped));
  assert.ok(![...lib.files.keys()].some((f) => f.endsWith('ignored.xml')), 'plain .xml is still not read');

  const top = (q) => lib.search(q)[0];
  let h = top('what does the payment service talk to');
  assert.match(h.rel, /payment-flow\.mmd$/);
  assert.ok(h.text.includes('- Payment Service -> Ledger DB: writes transactions'), h.text);
  assert.equal(h.headings[0], 'payment-flow');
  assert.match(top('where does the auth service sit and what does it call').rel, /identity\.puml$/);
  assert.match(top('what does the inventory manager send to the warehouse robots').rel, /shop\.dsl$/);
  assert.match(top('what serves static assets from the edge proxy').rel, /network\.dot$/);
  assert.match(top('which component asks the tax calculator for rates').rel, /billing\.drawio$/);
  assert.match(top('what is connected to the mainframe batch').rel, /legacy\.drawio\.xml$/);
  assert.match(top('what does the mobile client send to the push gateway').rel, /mobile\.excalidraw$/);
  h = top('what does the checkout module ask the pricing module');
  assert.match(h.rel, /arc42\.adoc$/);
  assert.ok(h.text.includes('- Checkout Module -> Pricing Module: asks for discounts'));
  assert.deepEqual(h.headings.slice(0, 2), ['Shop', 'Building block view']);
  h = top('what does the query router fan out to');
  assert.match(h.rel, /design\.md$/);
  assert.ok(h.text.includes('- Query Router -> Shards: fan out'), 'a fence in a Markdown note gains its connection list');
  assert.match(top('how are orders placed in the runtime view').rel, /runtime\.rst$/);
  // secrets never reach the index
  const all = lib.chunks.filter(Boolean).map((c) => c.text).join('\n');
  assert.ok(!all.includes('ghp_abcdefghijklmnopqrstuvwxyz0123456789'));
  assert.ok(stats.redacted >= 1);
  // changing a diagram is picked up on the next pass
  await new Promise((r) => setTimeout(r, 20));
  w('arch/payment-flow.mmd', 'flowchart LR\n  API[API Gateway] --> PAY(Payment Service)\n  PAY -->|publishes events| BUS[Event Bus]\n');
  await lib.reindex([{ dir, label: 'work', kind: 'work' }]);
  assert.ok(top('what does the payment service talk to').text.includes('- Payment Service -> Event Bus: publishes events'));
  assert.ok(!lib.chunks.filter(Boolean).some((c) => c.text.includes('Ledger DB')), 'the old version is gone');
});

test('fences in files with Windows line endings, tilde fences and info strings are described', () => {
  const md = '# T\r\n\r\n~~~ mermaid\r\ngraph LR\r\n  A[Alpha] --> B[Beta]\r\n~~~\r\n\r\nend\r\n';
  const out = describeFences(md);
  has(out, '- Alpha -> Beta');
  assert.ok(out.includes('~~~ mermaid\r\ngraph LR'), 'the original lines are untouched');
  const pu = describeFences('```plantuml title="x"\n@startuml\nA -> B : hello <<ok>>\n@enduml\n```\n');
  has(pu, '- A -> B: hello ok');
});
