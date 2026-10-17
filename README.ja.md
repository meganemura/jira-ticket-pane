# jira-ticket-pane

[English](README.md)

Claude Code の plugin（mod）である。
`/jira DEMO-1` は、セッションにすでに接続している MCP server から Jira の issue を 1 件取得し、transcript の横の pane に描く。
取得は plugin の中で実行する。
model のターンの一部として実行することはない。
pane のボタンを押すと、issue の文字が次のプロンプトに context として付く。

## 必要なもの

- Claude Code 2.1.280 以降。Claude Code 2.1.287 以降は mod を標準で読み込む。それより古い版では `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` を設定する。
  mod は early access である。API はリリースの間で変わることがある。
- CI は Claude Code の版を 2.1.280 に固定している。
- セッションに接続した MCP server と、Jira の issue を読む tool。
- terminal のセッション、または Claude Code Desktop の Code タブ。`-p` には pane がない。

## インストール

```sh
claude plugin marketplace add meganemura/jira-ticket-pane
claude plugin install jira-ticket-pane@jira-ticket-pane
```

checkout を使って開発するときは、作業ツリーから plugin を読み込む。

```sh
claude --plugin-dir /path/to/jira-ticket-pane/plugin
```

### Claude Code Desktop

pane は Claude Code Desktop の Code タブにも描かれる。
上の command で user スコープにインストールした plugin は、Desktop でも読み込まれる。
Desktop では `/plugin` は動かない。
アプリからインストールするには、プロンプト欄の横の + を押し、Plugins、Add marketplace の順に進んで `meganemura/jira-ticket-pane` を指定し、Add plugin を押す。

Desktop は `--plugin-dir` を受け取らない。
Desktop で checkout を使って開発するときは、`~/.claude/settings.json` の `env` に次を設定する。

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/jira-ticket-pane/plugin",
    "CLAUDE_CODE_PLUGIN_DIR_WATCH": "1"
  }
}
```

## `/jira`

- `/jira <KEY>` は issue を取得して pane に描く。pane が閉じていれば開く。
- key を付けない `/jira` は、pane の表示と非表示を切り替える。
- issue の上には上部バーがある。左に `issue` と `meta` のタブ、右に `↻` と `attach` のボタンがある。開いていないタブは薄く描く。
- `↻ <HH:MM>` ボタンは、今の issue をもう一度取得し、最後に取得した時刻を表示する。plugin はタイマーで何も取得しない。
- 両方のタブの上にあるヘッダは、key、summary、status、type、priority、assignee を表示する。status の点の色は、issue の status category で決まる。
- `issue` タブは description を表示する。
- `meta` タブはフィールドを表示し、`raw json` の折りたたみの下に生の JSON を表示する。
- `attach` ボタンを押すと、issue の文字を付ける準備をする。そのときラベルは `attached ✓` になる。もう一度押すと文字を外す。プロンプトを 1 つ送ると、文字は自動で外れる。plugin はプロンプト欄に書き込まない。
- `prompt.submit` の `context` フィールドは、プロンプトにすでに付いているすべての block を合わせて、最大 32,000 文字を持つ。plugin は、付ける issue の文字を、その上限の残りに収める。
- 全文が収まらないとき、plugin はその残りに収まるところまで行単位で残す。付ける文字の末尾には、切り詰めたことを示す注記を足す。注記は model が読む。pane には表示しない。
- ヘッダさえ収まらないとき、plugin は付けるのをやめ、status line を 1 行表示する。
- key は `[A-Z][A-Z0-9]+-\d+` に一致する。

## `/jira config`

標準では、plugin は実行時に呼び出す tool を探す。
探す規則は次のとおりである。
名前に "jira" と "issue" の両方を含み、"get"、"fetch"、"read"、"show" のどれか 1 つを含む MCP tool を探す。
複数の tool が一致するときは、名前がいちばん短いものを選ぶ。

一致する tool がないとき、pane はセッションに接続している MCP tool の名前を一覧にする。

- `/jira config server=<name> tool=<name>` は、特定の server と tool を固定する。
- `/jira config clear` は標準の探し方に戻す。

固定した値は plugin 自身の store に入り、セッションが終わっても残る。

tool を呼び出すとき、plugin は `issueIdOrKey`、`issueKey`、`key` の順に 3 つの引数名を試す。

Atlassian 自身の MCP server は、issue がある Atlassian の cloud サイトを示す `cloudId` も必要とする。
探した issue の tool がある server に、一致するサイト一覧の tool もあるとき、plugin はセッションごとに 1 回その tool を呼び出す。
plugin は、その tool が返す id を持っておく。
アクセスできるサイトが複数あるときは、それぞれのサイト名を挙げたエラーを表示し、issue の tool は呼び出さない。

`/jira config server=<name> tool=<name> cloud=<id>` は、サイトを手で固定する。
server と tool を固定して探すのを省くときは、`cloud=<id>` を付ける。
固定した tool は、自分でサイト一覧の tool を探さない。

## fixture モード

`JIRA_TICKET_PANE_FIXTURE=<dir>` を設定すると、本物の MCP server を呼び出す代わりに `<dir>/<KEY>.json` を読む。
それぞれの JSON ファイルは MCP tool の結果の形をとる。
`content` フィールド、`isError` フィールド、任意の `structuredContent` フィールドを持つ。

試すには次を実行する。

```sh
JIRA_TICKET_PANE_FIXTURE="$PWD/plugin/tests/fixtures" claude --plugin-dir "$PWD/plugin"
```

そのあと、セッションの中で `/jira DEMO-1` を実行する。

## 開発

新しい checkout では、`/plugin-types` を 1 回実行する。
型チェックが読む `.claude/types/claude-code.d.ts` を書き出す。

commit の前に、3 つのゲートを実行する。

```sh
claude plugin validate plugin
npx -p typescript tsc -p plugin/hooks
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test plugin
```

hook の失敗は fail open になる。
セッションは動き続け、失敗は `~/.claude/debug/<session>.txt` にだけ出る。

## 制限

- plugin は issue を読む。Jira には書き込まない。
- 1 回に取得する issue は 1 件である。
- 認証は扱わない。MCP server がエラーを返すと、pane は server のエラーの文字をそのまま表示する。
- plugin は Atlassian 自身の MCP server で動かしたことがある。応答がその server の形に一致するとき、`issue` タブは summary と description を描き、`meta` タブはそのほかのフィールドを描く。ほかの形の応答は、生の content block として描く。
