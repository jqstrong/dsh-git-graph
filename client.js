/**
 * Client half of `@local/dsh-git-graph`.
 *
 * A Conversation view (会话视图) that answers "what has been happening in this
 * session's working directory?" the way IDEA's Git tool window does: a refs
 * tree on the left, a commit table with a lane graph in the middle, and the
 * selected commit's message, changed files and unified diff on the right.
 *
 * Data comes from this bundle's Host half over one same-origin JSON route,
 * `api/plugin/git-graph`, read with `fetch` relative to `document.baseURI`
 * exactly like the shipped file-upload client (never a hard-coded host/port).
 * Every pixel is styled from DSH theme tokens, so light and dark both work and
 * nothing is imported from the shipped Client packages: React/react-dom come
 * from the page module table, the icons are inline SVG, and the stylesheet is
 * one `<style>` tag installed by `apply`.
 *
 * The lane-graph layout (`assignLanes`) is pure and deterministic: the same
 * commit list always yields the same lanes and segments. It is exported to the
 * test hook below so `test-client/` can assert it without a browser.
 */

window.__ModuleLoader__.load({
	id: '@local/dsh-git-graph',
	factory(require) {
		const React = require('react');
		const h = React.createElement;

		/** Locale namespace; also the Loader row id and the view id. */
		const NS = 'git-graph';

		/* ------------------------------------------------------------------ */
		/* Geometry and budgets                                                */
		/* ------------------------------------------------------------------ */

		/** Commit row height in px; the windowing math depends on this constant. */
		const ROW_HEIGHT = 26;
		/** Horizontal pitch of one lane in the graph gutter. */
		const LANE_WIDTH = 14;
		/** Left inset before the first lane, on both sides of the gutter. */
		const LANE_PAD = 10;
		/** Render cap for the gutter: very wide graphs keep the row readable. */
		const MAX_GRAPH_LANES = 16;
		/** Commit page size requested from the Host. */
		const PAGE_SIZE = 300;
		/** Windowed rendering kicks in above this filtered-row count. */
		const VIRTUAL_THRESHOLD = 240;
		/** Rows rendered beyond the viewport on each side. */
		const OVERSCAN = 10;
		/** Column widths of the commit table, outside the flexible subject. */
		const AUTHOR_WIDTH = 88;
		const DATE_WIDTH = 92;
		const SHA_WIDTH = 64;
		/** Right detail column width in the wide layout. */
		const DETAIL_WIDTH = 392;
		/** Wide/compact/inline breakpoints measured on the view container. */
		const COMPACT_WIDTH = 1080;
		const INLINE_WIDTH = 780;
		/** Commit-detail and file-diff LRU capacities. */
		const COMMIT_CACHE_LIMIT = 240;
		const DIFF_CACHE_LIMIT = 160;
		/** Sessions whose last selection is remembered across view switches. */
		const SESSION_MEMORY_LIMIT = 12;
		/** Above this relative age the table prints an absolute date instead. */
		const RELATIVE_MAX_DAYS = 7;
		/** One day in ms, for calendar-day comparisons. */
		const DAY_MS = 24 * 60 * 60 * 1000;
		/** Longest path shown verbatim in the toolbar before head truncation. */
		const PATH_MAX = 52;

		/**
		 * Lane palette. These are artwork colors (the one place the authoring
		 * guide allows literals): eight hues readable on both theme backgrounds.
		 */
		const LANE_COLORS = [
			'#4d93f8',
			'#22c55e',
			'#f7ad31',
			'#f25a5a',
			'#a78bfa',
			'#22b8cf',
			'#f472b6',
			'#979da6',
		];

		/* ------------------------------------------------------------------ */
		/* Locale dictionaries                                                 */
		/* ------------------------------------------------------------------ */

		const zh = {
			'view.label': 'Git',
			'view.aria': 'Git 提交树图',
			'refs.title': '引用',
			'refs.all': '全部提交',
			'refs.branches': '本地分支',
			'refs.remotes': '远程分支',
			'refs.tags': '标签',
			'refs.empty': '没有引用',
			'refs.headAhead': '领先 {ahead}',
			'refs.headBehind': '落后 {behind}',
			'toolbar.searchPlaceholder': '过滤提交…',
			'toolbar.searchAria': '按描述、作者或提交 SHA 过滤提交',
			'toolbar.refresh': '刷新',
			'toolbar.repoAria': '当前仓库：{path}，点击切换仓库目录',
			'toolbar.switchRepo': '切换仓库…',
			'toolbar.useSessionDir': '恢复会话工作目录',
			'toolbar.chooseRepo': '选择仓库目录',
			'repoMenu.title': '仓库',
			'repoMenu.aria': '仓库切换',
			'repoMenu.sessionDir': '会话工作目录',
			'repoMenu.notRepo': '非 Git 仓库',
			'repoMenu.discovered': '工作目录下的仓库（{count}）',
			'repoMenu.loading': '正在探测仓库…',
			'repoMenu.empty': '工作目录下未发现 Git 仓库',
			'repoMenu.error': '仓库探测失败',
			'repoMenu.retry': '重试',
			'repoMenu.pickDir': '选择其他目录…',
			'repoMenu.refresh': '刷新',
			'repoMenu.detached': '游离 HEAD @ {sha}',
			'repoMenu.detachedNoSha': '游离 HEAD',
			'repoMenu.unborn': '尚无提交',
			'repoMenu.unbornBranch': '{name}（尚无提交）',
			'repoMenu.current': '当前',
			'repoMenu.depthLimit': '已达到扫描深度上限',
			'repoMenu.countLimit': '已达到仓库数量上限',
			'repoMenu.dirLimit': '已达到扫描目录上限',
			'toolbar.details': '提交详情',
			'toolbar.closeDetails': '关闭提交详情',
			'toolbar.refsPanel': '引用面板',
			'toolbar.dirty': '{count} 个文件有未提交改动',
			'toolbar.ahead': '领先 {count}',
			'toolbar.behind': '落后 {count}',
			'toolbar.filteredBy': '筛选：{name}',
			'toolbar.clearFilter': '清除引用筛选',
			'toolbar.gitVersion': 'Git {version}',
			'col.description': '描述 / 提交',
			'col.author': '作者',
			'col.date': '日期',
			'col.commit': '提交',
			'list.loadMore': '加载更多…',
			'list.allLoaded': '已显示全部 {count} 个提交',
			'list.showingCount': '{shown} / {total} 个提交',
			'list.noResults': '没有匹配的提交',
			'list.noResultsHint': '按描述、作者或提交 SHA 过滤；Esc 清除。',
			'list.clearSearch': '清除搜索',
			'list.byRefClear': '清除引用筛选',
			'list.emptyRef': '这个引用下没有提交',
			'list.keyboardHint': '↑ ↓ 选择提交',
			'detail.empty': '选择一个提交查看详情',
			'detail.emptyHint': '点击中间列表中的任意一行提交。',
			'detail.loading': '正在读取提交详情…',
			'detail.files': '{count} 个文件',
			'detail.branches': '在 {count} 个分支中',
			'detail.author': '作者 {name}',
			'detail.committer': '提交者 {name}',
			'detail.bodyLabel': '提交说明',
			'detail.diffLoading': '正在读取差异…',
			'detail.diffFailed': '差异读取失败',
			'detail.binary': '二进制文件，无法显示差异',
			'detail.truncated': '差异过大，仅显示文件开头部分',
			'detail.noDiff': '这个文件没有可显示的差异',
			'detail.rename': '{oldPath} → {newPath}',
			'detail.expanded': '收起差异',
			'detail.fileAria': '文件 {path}，{status}，+{additions} −{deletions}，点击展开差异',
			'detail.retry': '重试',
			'detail.additions': '+{count}',
			'detail.deletions': '−{count}',
			'detail.noFiles': '没有变更文件',
			'state.loading': '正在读取仓库…',
			'state.notRepo.title': '当前会话工作目录不是 Git 仓库',
			'state.notRepo.desc': '在 Git 仓库中打开会话，或用下面的按钮选择一个仓库目录查看。',
			'state.pickedNotRepo.title': '所选目录不是 Git 仓库',
			'state.pickedNotRepo.desc': '请选择 Git 仓库的根目录，或包含仓库的目录。',
			'state.empty.title': '仓库还没有提交',
			'state.empty.desc': '这个仓库已经初始化，但还没有任何提交。',
			'state.empty.hint': '提交一次后，这里会显示分支、提交树图与文件差异。',
			'state.error.title': '无法读取 Git 数据',
			'state.error.retry': '重试',
			'state.error.code': '错误代码：{code}',
			'state.chooseRepo': '选择仓库目录',
			'state.backToSession': '恢复会话工作目录',
			'state.pickFailed': '选择目录失败：{message}',
			'state.pickFailedShort': '选择目录失败',
			'state.repoListTitle': '工作目录下的仓库',
			'state.repoListDesc': '选择一个仓库查看它的分支与提交。',
			'state.repoListLoading': '正在探测工作目录下的仓库…',
			'state.repoListError': '无法探测工作目录下的仓库',
			'state.noRepos': '工作目录下未发现 Git 仓库',
			'state.switching': '正在切换到 {path}…',
			'state.repoItemAria': '切换到仓库 {name}（{rel}）',
			'state.noGit.title': '未找到 git 可执行文件',
			'state.noGit.desc': '请先安装 Git 并确保它在 PATH 中，然后重试。',
			'state.sessionMissing.title': '无法定位会话工作目录',
			'state.sessionMissing.desc': '这个会话没有可用的工作目录，请选择一个仓库目录。',
			'error.notRepo': '不是 Git 仓库',
			'error.gitNotFound': '未找到 git 可执行文件',
			'error.network': '无法连接到 DSH 服务',
			'error.badResponse': '服务返回了无法解析的响应',
			'time.justNow': '刚刚',
			'time.minutesAgo': '{count} 分钟前',
			'time.hoursAgo': '{count} 小时前',
			'time.yesterday': '昨天',
			'time.daysAgo': '{count} 天前',
			'status.A': '新增',
			'status.M': '修改',
			'status.D': '删除',
			'status.R': '重命名',
			'status.C': '复制',
			'status.T': '类型变更',
			'status.Q': '未知',
			'a11y.view': 'Git 提交树图',
			'a11y.list': '提交列表',
			'a11y.refs': 'Git 引用',
		};

		const en = {
			'view.label': 'Git',
			'view.aria': 'Git commit graph',
			'refs.title': 'Refs',
			'refs.all': 'All commits',
			'refs.branches': 'Local branches',
			'refs.remotes': 'Remote branches',
			'refs.tags': 'Tags',
			'refs.empty': 'No refs',
			'refs.headAhead': '{ahead} ahead',
			'refs.headBehind': '{behind} behind',
			'toolbar.searchPlaceholder': 'Filter commits…',
			'toolbar.searchAria': 'Filter commits by description, author or SHA',
			'toolbar.refresh': 'Refresh',
			'toolbar.repoAria': 'Current repository: {path}. Click to switch repository directory',
			'toolbar.switchRepo': 'Switch repository…',
			'toolbar.useSessionDir': 'Back to the session working directory',
			'toolbar.chooseRepo': 'Choose repository…',
			'repoMenu.title': 'Repositories',
			'repoMenu.aria': 'Switch repository',
			'repoMenu.sessionDir': 'Session working directory',
			'repoMenu.notRepo': 'Not a Git repository',
			'repoMenu.discovered': 'Repositories under the working directory ({count})',
			'repoMenu.loading': 'Detecting repositories…',
			'repoMenu.empty': 'No Git repositories found under the working directory',
			'repoMenu.error': 'Could not scan for repositories',
			'repoMenu.retry': 'Retry',
			'repoMenu.pickDir': 'Choose another directory…',
			'repoMenu.refresh': 'Refresh',
			'repoMenu.detached': 'Detached HEAD @ {sha}',
			'repoMenu.detachedNoSha': 'Detached HEAD',
			'repoMenu.unborn': 'no commits',
			'repoMenu.unbornBranch': '{name} (no commits)',
			'repoMenu.current': 'Current',
			'repoMenu.depthLimit': 'Directory depth limit reached',
			'repoMenu.countLimit': 'Repository count limit reached',
			'repoMenu.dirLimit': 'Directory scan limit reached',
			'toolbar.details': 'Commit details',
			'toolbar.closeDetails': 'Close commit details',
			'toolbar.refsPanel': 'Refs panel',
			'toolbar.dirty': '{count} uncommitted files',
			'toolbar.ahead': '{count} ahead',
			'toolbar.behind': '{count} behind',
			'toolbar.filteredBy': 'Filter: {name}',
			'toolbar.clearFilter': 'Clear ref filter',
			'toolbar.gitVersion': 'Git {version}',
			'col.description': 'Description / commit',
			'col.author': 'Author',
			'col.date': 'Date',
			'col.commit': 'Commit',
			'list.loadMore': 'Load more…',
			'list.allLoaded': 'All {count} commits shown',
			'list.showingCount': '{shown} / {total} commits',
			'list.noResults': 'No matching commits',
			'list.noResultsHint': 'Filter by description, author or SHA; press Esc to clear.',
			'list.clearSearch': 'Clear search',
			'list.byRefClear': 'Clear ref filter',
			'list.emptyRef': 'No commits under this ref',
			'list.keyboardHint': '↑ ↓ select a commit',
			'detail.empty': 'Select a commit to see its details',
			'detail.emptyHint': 'Click any row in the commit table.',
			'detail.loading': 'Reading the commit…',
			'detail.files': '{count} files',
			'detail.branches': 'in {count} branches',
			'detail.author': 'Author {name}',
			'detail.committer': 'Committer {name}',
			'detail.bodyLabel': 'Commit message',
			'detail.diffLoading': 'Reading the diff…',
			'detail.diffFailed': 'Could not read the diff',
			'detail.binary': 'Binary file — no textual diff',
			'detail.truncated': 'Diff too large — only the beginning is shown',
			'detail.noDiff': 'No diff to show for this file',
			'detail.rename': '{oldPath} → {newPath}',
			'detail.expanded': 'Collapse diff',
			'detail.fileAria': 'File {path}, {status}, +{additions} −{deletions}, click to expand the diff',
			'detail.retry': 'Retry',
			'detail.additions': '+{count}',
			'detail.deletions': '−{count}',
			'detail.noFiles': 'No changed files',
			'state.loading': 'Reading the repository…',
			'state.notRepo.title': 'The session working directory is not a Git repository',
			'state.notRepo.desc': 'Open the session inside a Git repository, or choose a repository directory below.',
			'state.pickedNotRepo.title': 'The chosen directory is not a Git repository',
			'state.pickedNotRepo.desc': 'Choose the root of a Git repository, or a directory that contains one.',
			'state.empty.title': 'The repository has no commits yet',
			'state.empty.desc': 'This repository is initialized but has no commits.',
			'state.empty.hint': 'After the first commit, branches, the graph and diffs appear here.',
			'state.error.title': 'Could not read Git data',
			'state.error.retry': 'Retry',
			'state.error.code': 'Error code: {code}',
			'state.chooseRepo': 'Choose repository…',
			'state.backToSession': 'Back to the session directory',
			'state.pickFailed': 'Directory picker failed: {message}',
			'state.pickFailedShort': 'Directory picker failed',
			'state.repoListTitle': 'Repositories in the working directory',
			'state.repoListDesc': 'Pick a repository to see its branches and commits.',
			'state.repoListLoading': 'Detecting repositories in the working directory…',
			'state.repoListError': 'Could not scan the working directory for repositories',
			'state.noRepos': 'No Git repositories found in the working directory',
			'state.switching': 'Switching to {path}…',
			'state.repoItemAria': 'Switch to repository {name} ({rel})',
			'state.noGit.title': 'git executable not found',
			'state.noGit.desc': 'Install Git and make sure it is on PATH, then retry.',
			'state.sessionMissing.title': 'No working directory for this session',
			'state.sessionMissing.desc': 'This session has no usable working directory; choose a repository below.',
			'error.notRepo': 'Not a Git repository',
			'error.gitNotFound': 'git executable not found',
			'error.network': 'Cannot reach the DSH service',
			'error.badResponse': 'The service returned an unreadable response',
			'time.justNow': 'just now',
			'time.minutesAgo': '{count} min ago',
			'time.hoursAgo': '{count} h ago',
			'time.yesterday': 'yesterday',
			'time.daysAgo': '{count} d ago',
			'status.A': 'added',
			'status.M': 'modified',
			'status.D': 'deleted',
			'status.R': 'renamed',
			'status.C': 'copied',
			'status.T': 'type changed',
			'status.Q': 'unknown',
			'a11y.view': 'Git commit graph',
			'a11y.list': 'Commit list',
			'a11y.refs': 'Git refs',
		};

		/** Local fallback translator: the locale seat is absent in a bare render. */
		function fallbackTranslate(key, params) {
			const template = zh[key] ?? key;
			if (params === undefined) return template;
			return template.replace(/\{(\w+)\}/gu, (match, name) => (name in params ? String(params[name]) : match));
		}

		/* ------------------------------------------------------------------ */
		/* Stylesheet                                                          */
		/* ------------------------------------------------------------------ */

		/**
		 * Artwork colours, declared as custom properties so the rest of the
		 * stylesheet never carries a literal. Two theme-scoped overrides improve
		 * contrast on the dark surface (the host marks it on `body`).
		 */
		const laneVars = LANE_COLORS.map((color, index) => `--gg-lane-${index}:${color}`).join(';');

		const CSS = [
			/* Root surface: the tool window itself. */
			`.dshGitGraph_root{${laneVars};--gg-selected:color-mix(in srgb,var(--dsw-alias-state-business-primary) 9%,transparent);`,
			'--gg-add-bg:color-mix(in srgb,var(--dsw-static-green-500) 13%,transparent);',
			'--gg-del-bg:color-mix(in srgb,var(--dsw-static-red-500) 12%,transparent);',
			'--gg-add-text:var(--dsw-static-green-500);--gg-del-text:var(--dsw-static-red-600);',
			'--gg-hunk-bg:color-mix(in srgb,var(--dsw-alias-state-business-primary) 9%,transparent);',
			'--gg-status-add:var(--dsw-static-green-500);--gg-status-modify:var(--dsw-static-amber-600);',
			'--gg-status-delete:var(--dsw-static-red-600);--gg-status-rename:var(--dsw-alias-state-business-primary);',
			'--gg-status-copy:#22b8cf;--gg-status-type:#a78bfa;',
			'box-sizing:border-box;position:relative;display:flex;flex-direction:column;min-width:0;min-height:0;',
			'width:100%;height:100%;min-height:320px;overflow:hidden;background:var(--dsw-alias-bg-base);',
			'color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family,inherit);',
			'font-size:calc(var(--dsh-content-font-size,14px) - 1px);line-height:18px;-webkit-font-smoothing:antialiased}',
			'body[data-ds-dark-theme] .dshGitGraph_root{--gg-add-text:var(--dsw-static-green-400);',
			'--gg-del-text:var(--dsw-static-red-400);--gg-status-add:var(--dsw-static-green-400);',
			'--gg-status-modify:var(--dsw-static-amber-400);--gg-status-delete:var(--dsw-static-red-400)}',
			'.dshGitGraph_root *,.dshGitGraph_root *:before,.dshGitGraph_root *:after{box-sizing:border-box}',

			/* Toolbar. */
			'.dshGitGraph_toolbar{flex:none;display:flex;align-items:center;gap:8px;min-height:38px;padding:5px 10px;',
			'border-bottom:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-base)}',
			'.dshGitGraph_repo{display:inline-flex;align-items:center;gap:6px;min-width:0;max-width:min(46%,420px);',
			'height:26px;padding:0 7px;border:none;border-radius:var(--dsw-radius-xs);background:0 0;',
			'color:var(--dsw-alias-label-tertiary);font:inherit;font-size:11.5px;cursor:pointer}',
			'.dshGitGraph_repo:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
			'.dshGitGraph_repo svg{flex:none;width:13px;height:13px;opacity:.75}',
			'.dshGitGraph_repoPath{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
			'.dshGitGraph_tools{display:inline-flex;align-items:center;gap:6px;flex:none;min-width:0}',
			'.dshGitGraph_headChip{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 8px;',
			'border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-interactive-bg-hover);',
			'color:var(--dsw-alias-label-secondary);font-size:11.5px;white-space:nowrap;min-width:0;max-width:220px}',
			'.dshGitGraph_headChip svg{flex:none;width:12px;height:12px;opacity:.7}',
			'.dshGitGraph_headChip b{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;',
			'color:var(--dsw-alias-label-primary);font-weight:500}',
			'.dshGitGraph_headSha{flex:none;font-family:ui-monospace,"Cascadia Code",Consolas,monospace;',
			'font-size:10.5px;color:var(--dsw-alias-label-caption);font-variant-numeric:tabular-nums}',
			'.dshGitGraph_metaChip{display:inline-flex;align-items:center;gap:3px;height:20px;padding:0 6px;',
			'border-radius:var(--dsw-radius-xs);font-size:10.5px;color:var(--dsw-alias-label-tertiary);',
			'white-space:nowrap;font-variant-numeric:tabular-nums}',
			'.dshGitGraph_metaChip svg{flex:none;width:11px;height:11px}',
			'.dshGitGraph_metaDirty{color:var(--dsw-static-amber-600);',
			'background:color-mix(in srgb,var(--dsw-static-amber-500) 13%,transparent)}',
			'body[data-ds-dark-theme] .dshGitGraph_metaDirty{color:var(--dsw-static-amber-400)}',
			'.dshGitGraph_metaAhead{color:var(--dsw-alias-state-success-primary)}',
			'.dshGitGraph_metaBehind{color:var(--dsw-alias-state-error-primary)}',
			'.dshGitGraph_spacer{flex:1;min-width:4px}',
			'.dshGitGraph_filterChip{display:inline-flex;align-items:center;gap:4px;height:22px;padding:0 4px 0 7px;',
			'border:none;border-radius:var(--dsw-radius-xs);background:var(--gg-selected);cursor:pointer;',
			'color:var(--dsw-alias-state-business-primary);font-family:inherit;font-size:11px;',
			'white-space:nowrap;max-width:200px;overflow:hidden}',
			'.dshGitGraph_filterChip span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
			'.dshGitGraph_filterChip svg{flex:none;width:11px;height:11px}',
			'.dshGitGraph_filterChip:hover{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 16%,transparent)}',
			'.dshGitGraph_search{position:relative;display:inline-flex;align-items:center;flex:none}',
			'.dshGitGraph_search svg{position:absolute;left:7px;width:12px;height:12px;',
			'color:var(--dsw-alias-label-caption);pointer-events:none}',
			'.dshGitGraph_searchInput{box-sizing:border-box;width:190px;height:26px;padding:0 8px 0 23px;',
			'border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-xs);',
			'background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);',
			'font-family:inherit;font-size:11.5px;outline:none}',
			'.dshGitGraph_searchInput::placeholder{color:var(--dsw-alias-label-caption)}',
			'.dshGitGraph_searchInput:focus{border-color:var(--dsw-alias-state-business-primary);',
			'box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-state-business-primary) 16%,transparent)}',
			'.dshGitGraph_iconBtn{display:inline-flex;align-items:center;justify-content:center;flex:none;',
			'width:26px;height:26px;padding:0;border:none;border-radius:var(--dsw-radius-xs);background:0 0;',
			'color:var(--dsw-alias-label-secondary);cursor:pointer}',
			'.dshGitGraph_iconBtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
			'.dshGitGraph_iconBtn svg{width:14px;height:14px}',
			'.dshGitGraph_iconBtn[data-spinning=true] svg{animation:dshGitGraphSpin .9s linear infinite}',
			'@keyframes dshGitGraphSpin{to{transform:rotate(360deg)}}',
			'.dshGitGraph_iconBtn:focus-visible,.dshGitGraph_button:focus-visible,',
			'.dshGitGraph_row:focus-visible,.dshGitGraph_fileRow:focus-visible,.dshGitGraph_linkButton:focus-visible{',
			'outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}',
			'.dshGitGraph_button{display:inline-flex;align-items:center;justify-content:center;gap:6px;',
			'height:26px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l2);',
			'border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-bg-base);',
			'color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:11.5px;cursor:pointer;white-space:nowrap}',
			'.dshGitGraph_button:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
			'.dshGitGraph_button svg{width:13px;height:13px}',
			'.dshGitGraph_button[data-variant=primary]{border-color:transparent;',
			'background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 12%,transparent);',
			'color:var(--dsw-alias-state-business-primary)}',
			'.dshGitGraph_button[data-variant=primary]:hover{',
			'background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 20%,transparent)}',

			/* Three columns. */
			'.dshGitGraph_body{position:relative;display:flex;flex:1;min-height:0;min-width:0}',
			'.dshGitGraph_refs{flex:none;display:flex;flex-direction:column;min-height:0;min-width:0;',
			'overflow-y:auto;overflow-x:hidden;padding:6px 6px 14px;',
			'border-right:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-base)}',
			'.dshGitGraph_refsHead{flex:none;display:flex;align-items:center;gap:6px;height:24px;padding:0 6px;',
			'color:var(--dsw-alias-label-tertiary);font-size:10.5px;font-weight:600;letter-spacing:.05em;',
			'text-transform:uppercase}',
			'.dshGitGraph_refs[data-drawer=true]{position:absolute;top:0;bottom:0;left:0;z-index:7;',
			'width:min(268px,88%);border-right:.5px solid var(--dsw-alias-border-l3);',
			'box-shadow:var(--dsw-elevation-prominent);background:var(--dsw-alias-bg-base)}',
			'.dshGitGraph_allRow,.dshGitGraph_refRow{display:flex;align-items:center;gap:6px;width:100%;height:24px;',
			'padding:0 6px;border:none;border-radius:var(--dsw-radius-xs);background:0 0;',
			'color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:11.5px;text-align:left;',
			'cursor:pointer;overflow:hidden}',
			'.dshGitGraph_allRow:hover,.dshGitGraph_refRow:hover{background:var(--dsw-alias-interactive-bg-hover);',
			'color:var(--dsw-alias-label-primary)}',
			'.dshGitGraph_allRow[aria-current=true],.dshGitGraph_refRow[aria-current=true]{',
			'background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary)}',
			'.dshGitGraph_allRow svg,.dshGitGraph_refRow svg{flex:none;width:13px;height:13px;opacity:.65}',
			'.dshGitGraph_refName{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
			'.dshGitGraph_refRow[data-head=true] .dshGitGraph_refName{color:var(--dsw-alias-label-primary);font-weight:500}',
			'.dshGitGraph_refRow[data-head=true] svg{opacity:.9;color:var(--dsw-alias-state-business-primary)}',
			'.dshGitGraph_headDot{flex:none;width:5px;height:5px;border-radius:50%;',
			'background:var(--dsw-alias-state-business-primary);margin-left:auto}',
			'.dshGitGraph_refAhead{flex:none;margin-left:auto;font-size:10px;color:var(--dsw-alias-label-caption);',
			'font-variant-numeric:tabular-nums;white-space:nowrap}',
			'.dshGitGraph_refGroup{margin-top:6px}',
			'.dshGitGraph_refGroupHead{display:flex;align-items:center;gap:3px;width:100%;height:22px;padding:0 6px;',
			'border:none;background:0 0;border-radius:var(--dsw-radius-xs);color:var(--dsw-alias-label-tertiary);',
			'font-family:inherit;font-size:10.5px;font-weight:600;letter-spacing:.03em;cursor:pointer}',
			'.dshGitGraph_refGroupHead:hover{background:var(--dsw-alias-interactive-bg-hover)}',
			'.dshGitGraph_refGroupHead svg{flex:none;width:10px;height:10px;transition:transform .12s ease}',
			'.dshGitGraph_refCount{margin-left:auto;font-weight:400;color:var(--dsw-alias-label-caption);',
			'font-variant-numeric:tabular-nums}',
			'.dshGitGraph_refEmpty{padding:1px 6px 3px 23px;font-size:11px;color:var(--dsw-alias-label-caption)}',
			'.dshGitGraph_refsEmptyHead{padding:2px 8px;font-size:10.5px;color:var(--dsw-alias-label-caption)}',

			/* Commit table. */
			'.dshGitGraph_listCol{display:flex;flex-direction:column;flex:1;min-width:0;min-height:0}',
			'.dshGitGraph_listHead{flex:none;display:grid;align-items:center;height:25px;padding-right:8px;',
			'border-bottom:.5px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-tertiary);',
			'font-size:10.5px;font-weight:500;letter-spacing:.03em;background:var(--dsw-alias-bg-base)}',
			'.dshGitGraph_listHeadCell{padding-left:8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
			'.dshGitGraph_listHeadCell[data-align=end]{padding-left:8px;text-align:right}',
			'.dshGitGraph_listScroll{flex:1;min-height:0;overflow:auto;outline:none;position:relative}',
			'.dshGitGraph_listScroll:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));',
			'outline-offset:-2px}',
			'.dshGitGraph_row{position:relative;display:grid;align-items:center;height:26px;margin:0;',
			'padding-right:8px;border:none;background:0 0;text-align:left;font-family:inherit;',
			'color:var(--dsw-alias-label-primary);cursor:pointer;content-visibility:auto;',
			'contain-intrinsic-size:auto 26px}',
			'.dshGitGraph_row:hover{background:var(--dsw-alias-interactive-bg-hover)}',
			'.dshGitGraph_row[aria-selected=true]{background:var(--gg-selected)}',
			'.dshGitGraph_row[aria-selected=true]:before{content:"";position:absolute;left:0;top:0;bottom:0;',
			'width:2px;background:var(--dsw-alias-state-business-primary)}',
			'.dshGitGraph_graphCell{display:flex;align-items:center;height:100%;min-width:0;overflow:hidden;padding-left:2px}',
			'.dshGitGraph_graphSvg{display:block;flex:none;overflow:visible}',
			'.dshGitGraph_headRing{fill:none;opacity:.55}',
			'.dshGitGraph_subjectCell{display:flex;align-items:center;gap:8px;min-width:0;overflow:hidden;padding-left:8px}',
			'.dshGitGraph_subjectText{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;',
			'font-size:12.5px;line-height:25px}',
			'.dshGitGraph_pills{display:flex;align-items:center;gap:4px;flex:none;min-width:0;max-width:44%;overflow:hidden}',
			'.dshGitGraph_pill{display:inline-flex;align-items:center;gap:3px;flex:none;height:16px;padding:0 5px;',
			'border-radius:3px;font-size:10px;font-weight:500;line-height:16px;white-space:nowrap;',
			'max-width:160px;overflow:hidden;text-overflow:ellipsis}',
			'.dshGitGraph_pill svg{flex:none;width:9px;height:9px}',
			'.dshGitGraph_pillBranch{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 14%,transparent);',
			'color:var(--dsw-alias-state-business-primary)}',
			'.dshGitGraph_pillRemote{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-tertiary)}',
			'.dshGitGraph_pillTag{background:color-mix(in srgb,var(--dsw-static-amber-500) 15%,transparent);',
			'color:var(--dsw-static-amber-600)}',
			'body[data-ds-dark-theme] .dshGitGraph_pillTag{color:var(--dsw-static-amber-400)}',
			'.dshGitGraph_authorCell{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;',
			'padding-left:8px;font-size:11px;color:var(--dsw-alias-label-tertiary)}',
			'.dshGitGraph_dateCell{justify-self:end;padding-left:8px;font-size:10.5px;',
			'color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap}',
			'.dshGitGraph_shaCell{justify-self:end;padding-left:8px;',
			'font-family:ui-monospace,"Cascadia Code",Consolas,monospace;font-size:10px;',
			'color:var(--dsw-alias-label-caption);font-variant-numeric:tabular-nums}',
			'.dshGitGraph_listFoot{flex:none;display:flex;align-items:center;justify-content:space-between;',
			'gap:8px;min-height:24px;padding:0 10px;border-top:.5px solid var(--dsw-alias-border-l1);',
			'color:var(--dsw-alias-label-caption);font-size:10px}',
			'.dshGitGraph_listFootLeft{display:inline-flex;align-items:center;gap:8px;min-width:0;overflow:hidden}',
			'.dshGitGraph_noResults{display:flex;flex-direction:column;align-items:center;justify-content:center;',
			'gap:8px;padding:32px 20px;color:var(--dsw-alias-label-tertiary);font-size:11.5px;text-align:center}',
			'.dshGitGraph_noResults svg{width:22px;height:22px;opacity:.45}',
			'.dshGitGraph_linkButton{display:inline;padding:2px 4px;border:none;border-radius:4px;background:0 0;',
			'color:var(--dsw-alias-state-business-primary);font-family:inherit;font-size:inherit;cursor:pointer}',
			'.dshGitGraph_linkButton:hover{text-decoration:underline}',

			/* Commit detail column. */
			'.dshGitGraph_detail{flex:none;display:flex;flex-direction:column;min-height:0;min-width:0;',
			'border-left:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-base)}',
			'.dshGitGraph_detail[data-drawer=true]{position:absolute;top:0;right:0;bottom:0;z-index:6;',
			'width:min(420px,94%);border-left:.5px solid var(--dsw-alias-border-l3);',
			'box-shadow:var(--dsw-elevation-prominent)}',
			'.dshGitGraph_detailScroll{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;padding:12px 14px 24px}',
			'.dshGitGraph_detailSubject{margin:0 0 8px;font-size:13.5px;font-weight:600;line-height:19px;',
			'color:var(--dsw-alias-label-primary);word-break:break-word;padding-right:20px}',
			'.dshGitGraph_drawerClose{position:absolute;top:8px;right:8px;z-index:1;background:var(--dsw-alias-bg-base)}',
			'.dshGitGraph_metaRow{display:flex;align-items:center;gap:6px;flex-wrap:wrap;',
			'color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:17px}',
			'.dshGitGraph_avatar{display:inline-flex;align-items:center;justify-content:center;flex:none;',
			'width:16px;height:16px;border-radius:50%;background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 15%,transparent);',
			'color:var(--dsw-alias-state-business-primary);font-size:8.5px;font-weight:700;text-transform:uppercase}',
			'.dshGitGraph_avatar svg{width:11px;height:11px}',
			'.dshGitGraph_committerRow{margin-top:1px;font-size:10.5px;line-height:15px;',
			'color:var(--dsw-alias-label-caption)}',
			'.dshGitGraph_mono{font-family:ui-monospace,"Cascadia Code",Consolas,monospace;',
			'font-variant-numeric:tabular-nums}',
			'.dshGitGraph_metaStrong{color:var(--dsw-alias-label-secondary)}',
			'.dshGitGraph_metaSep{color:var(--dsw-alias-label-caption);opacity:.7}',
			'.dshGitGraph_bodyText{margin:10px 0 0;padding:8px 10px;border-radius:var(--dsw-radius-xs);',
			'background:var(--dsw-alias-markdown-code-block);color:var(--dsw-alias-label-secondary);',
			'font-size:11.5px;line-height:17px;white-space:pre-wrap;word-break:break-word}',
			'.dshGitGraph_statsRow{display:flex;align-items:center;gap:8px;margin:12px 0 4px;padding-top:10px;',
			'border-top:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);font-size:11px}',
			'.dshGitGraph_add{color:var(--gg-add-text);font-variant-numeric:tabular-nums}',
			'.dshGitGraph_del{color:var(--gg-del-text);font-variant-numeric:tabular-nums}',
			'.dshGitGraph_fileList{display:flex;flex-direction:column;gap:1px}',
			'.dshGitGraph_fileWrap{border-radius:var(--dsw-radius-xs);overflow:hidden}',
			'.dshGitGraph_fileRow{display:grid;grid-template-columns:13px minmax(0,1fr) auto;align-items:center;',
			'gap:6px;width:100%;min-height:24px;padding:1px 6px;border:none;border-radius:var(--dsw-radius-xs);',
			'background:0 0;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:11px;',
			'text-align:left;cursor:pointer}',
			'.dshGitGraph_fileRow:hover{background:var(--dsw-alias-interactive-bg-hover)}',
			'.dshGitGraph_fileRow[data-open=true]{background:var(--dsw-alias-interactive-bg-hover)}',
			'.dshGitGraph_fileStatus{font-family:ui-monospace,"Cascadia Code",Consolas,monospace;',
			'font-weight:700;font-size:10px;text-align:center;line-height:14px}',
			'.dshGitGraph_filePath{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
			'.dshGitGraph_fileDir{color:var(--dsw-alias-label-caption)}',
			'.dshGitGraph_fileName{color:var(--dsw-alias-label-secondary)}',
			'.dshGitGraph_fileCounts{flex:none;display:inline-flex;gap:6px;font-size:10px;',
			'font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-caption)}',
			'.dshGitGraph_diffBox{margin:2px 0 6px;border-top:.5px solid var(--dsw-alias-border-l1);',
			'border-bottom:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-markdown-code-block);',
			'overflow-x:auto;overflow-y:hidden}',
			'.dshGitGraph_diffInner{width:max-content;min-width:100%}',
			'.dshGitGraph_diffRow{display:flex;align-items:flex-start;min-height:16px;white-space:pre;',
			'width:max-content;min-width:100%;line-height:16px}',
			'.dshGitGraph_diffNum{flex:none;position:sticky;z-index:1;width:38px;padding:0 6px;text-align:right;',
			'font-family:ui-monospace,"Cascadia Code",Consolas,monospace;font-size:10px;',
			'color:var(--dsw-alias-label-caption);user-select:none;',
			'background:var(--dsw-alias-markdown-code-block)}',
			'.dshGitGraph_diffNum:first-child{left:0}',
			'.dshGitGraph_diffNum:nth-child(2){left:38px}',
			'.dshGitGraph_diffRowAdd .dshGitGraph_diffNum{',
			'background:color-mix(in srgb,var(--dsw-static-green-500) 7%,var(--dsw-alias-markdown-code-block))}',
			'.dshGitGraph_diffRowDel .dshGitGraph_diffNum{',
			'background:color-mix(in srgb,var(--dsw-static-red-500) 7%,var(--dsw-alias-markdown-code-block))}',
			'.dshGitGraph_diffMark{flex:none;width:14px;text-align:center;user-select:none;',
			'font-family:ui-monospace,"Cascadia Code",Consolas,monospace;font-size:10.5px;',
			'color:var(--dsw-alias-label-caption)}',
			'.dshGitGraph_diffText{flex:none;padding:0 12px 0 4px;',
			'font-family:ui-monospace,"Cascadia Code",Consolas,monospace;',
			'font-size:var(--dsh-code-font-size,11px);color:var(--dsw-alias-label-secondary)}',
			'.dshGitGraph_diffRowAdd{background:var(--gg-add-bg)}',
			'.dshGitGraph_diffRowAdd .dshGitGraph_diffMark{color:var(--gg-add-text)}',
			'.dshGitGraph_diffRowDel{background:var(--gg-del-bg)}',
			'.dshGitGraph_diffRowDel .dshGitGraph_diffMark{color:var(--gg-del-text)}',
			'.dshGitGraph_diffHunk{padding:3px 10px;white-space:pre;color:var(--dsw-alias-label-tertiary);',
			'background:var(--gg-hunk-bg);font-family:ui-monospace,"Cascadia Code",Consolas,monospace;',
			'font-size:10.5px;border-top:.5px solid var(--dsw-alias-border-l1)}',
			'.dshGitGraph_diffNotice{padding:6px 10px;color:var(--dsw-alias-label-caption);',
			'font-size:10.5px;font-style:italic}',
			'.dshGitGraph_diffLoading{padding:8px 10px;color:var(--dsw-alias-label-caption);font-size:10.5px}',
			'.dshGitGraph_fileBanner{margin:2px 0 6px;padding:6px 8px;border-radius:var(--dsw-radius-xs);',
			'background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);',
			'color:var(--dsw-alias-state-error-primary);font-size:10.5px;display:flex;align-items:center;gap:8px}',
			'.dshGitGraph_detailBanner{margin:0 0 10px;padding:8px 10px;border-radius:var(--dsw-radius-xs);',
			'background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);',
			'color:var(--dsw-alias-state-error-primary);font-size:11px;line-height:16px}',

			/* Empty, loading and error states. */
			'.dshGitGraph_statePanel{display:flex;flex-direction:column;align-items:center;justify-content:center;',
			'gap:9px;flex:1;min-height:0;padding:28px 24px;text-align:center;color:var(--dsw-alias-label-tertiary)}',
			'.dshGitGraph_stateIcon{display:flex;align-items:center;justify-content:center;width:44px;height:44px;',
			'border-radius:12px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-tertiary)}',
			'.dshGitGraph_stateIcon svg{width:24px;height:24px}',
			'.dshGitGraph_stateTitle{font-size:13.5px;font-weight:600;color:var(--dsw-alias-label-primary);',
			'line-height:20px;max-width:480px}',
			'.dshGitGraph_stateDesc{max-width:440px;font-size:11.5px;line-height:17px;',
			'color:var(--dsw-alias-label-tertiary)}',
			'.dshGitGraph_statePath{max-width:min(560px,90%);padding:4px 9px;border-radius:var(--dsw-radius-xs);',
			'background:var(--dsw-alias-markdown-code-block);color:var(--dsw-alias-label-secondary);',
			'font-family:ui-monospace,"Cascadia Code",Consolas,monospace;font-size:11px;word-break:break-all}',
			'.dshGitGraph_stateActions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:center;',
			'margin-top:3px}',
			'.dshGitGraph_stateCode{font-family:ui-monospace,"Cascadia Code",Consolas,monospace;',
			'font-size:10px;color:var(--dsw-alias-label-caption)}',
			'.dshGitGraph_detailEmpty{display:flex;flex-direction:column;align-items:center;justify-content:center;',
			'gap:8px;height:100%;padding:24px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:11.5px}',
			'.dshGitGraph_detailEmpty svg{width:26px;height:26px;opacity:.4}',

			/* Repository switcher: toolbar trigger, dropdown menu and not-a-repo list. */
			'.dshGitGraph_repoWrap{position:relative;display:inline-flex;min-width:0;flex:none;max-width:min(46%,420px)}',
			'.dshGitGraph_repoWrap .dshGitGraph_repo{max-width:100%}',
			'.dshGitGraph_repoTrigger .dshGitGraph_repoCaret{flex:none;width:10px;height:10px;opacity:.6}',
			'.dshGitGraph_repoMenu{position:absolute;top:calc(100% + 5px);left:0;z-index:30;display:flex;flex-direction:column;',
			'gap:1px;width:min(360px,calc(100vw - 30px));max-height:min(430px,70vh);overflow:auto;padding:5px;',
			'background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-primary);',
			'border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md,12px);',
			'box-shadow:var(--dsw-elevation-prominent);',
			'backdrop-filter:var(--dsw-menu-backdrop-filter,blur(20px));-webkit-backdrop-filter:var(--dsw-menu-backdrop-filter,blur(20px))}',
			'.dshGitGraph_repoMenu[data-compact=true]{width:min(320px,calc(100vw - 24px))}',
			'.dshGitGraph_repoMenuHead{flex:none;display:flex;align-items:center;gap:6px;padding:3px 7px 4px;',
			'font-size:10px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--dsw-alias-label-caption)}',
			'.dshGitGraph_repoMenuSection{flex:none;padding:4px 7px 2px;overflow:hidden;text-overflow:ellipsis;',
			'white-space:nowrap;font-size:10.5px;color:var(--dsw-alias-label-caption)}',
			'.dshGitGraph_repoMenuSep{flex:none;height:.5px;margin:4px 3px;background:var(--dsw-alias-border-l3)}',
			'.dshGitGraph_repoItem{display:flex;flex:none;align-items:center;gap:7px;width:100%;min-height:30px;padding:4px 7px;',
			'border:none;border-radius:var(--dsw-radius-xs);background:0 0;color:var(--dsw-alias-label-primary);',
			'font:inherit;text-align:left;cursor:pointer}',
			'.dshGitGraph_repoItem:hover{background:var(--dsw-alias-interactive-bg-hover)}',
			'.dshGitGraph_repoItem:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));',
			'outline-offset:-2px}',
			'.dshGitGraph_repoItem[data-active=true]{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 10%,transparent)}',
			'.dshGitGraph_repoItem>svg:first-child{flex:none;width:13px;height:13px;opacity:.7}',
			'.dshGitGraph_repoItemMain{display:flex;flex:1;flex-direction:column;min-width:0}',
			'.dshGitGraph_repoItemName{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}',
			'.dshGitGraph_repoItemMeta{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;',
			'font-size:10.5px;line-height:14px;color:var(--dsw-alias-label-tertiary)}',
			'.dshGitGraph_repoItemCheck{flex:none;width:12px;height:12px;color:var(--dsw-alias-state-business-primary)}',
			'.dshGitGraph_repoEmpty{display:flex;flex:none;align-items:center;gap:6px;flex-wrap:wrap;padding:4px 7px;',
			'font-size:10.5px;line-height:15px;color:var(--dsw-alias-label-caption)}',
			'.dshGitGraph_repoMenuFoot{flex:none;display:flex;align-items:center;gap:4px;padding:2px 2px 1px}',
			'.dshGitGraph_repoMenuFoot .dshGitGraph_button{flex:1;justify-content:flex-start;height:26px}',
			'.dshGitGraph_stateRepos{display:flex;flex-direction:column;align-items:center;gap:2px;width:100%;',
			'max-width:520px;margin:6px auto 0;padding:0 8px;flex:none}',
			'.dshGitGraph_stateReposTitle{font-size:11.5px;font-weight:600;color:var(--dsw-alias-label-secondary)}',
			'.dshGitGraph_stateReposDesc{font-size:10.5px;line-height:15px;color:var(--dsw-alias-label-caption);text-align:center}',
			'.dshGitGraph_repoList{display:flex;flex-direction:column;gap:1px;width:100%;margin-top:4px;padding:4px;',
			'border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-s,8px);',
			'background:var(--dsw-alias-markdown-code-block)}',
			'.dshGitGraph_repoList .dshGitGraph_repoItem{min-height:32px}',

			/* Degraded states (not-a-repo / empty / error): one centered column that
			 * stays above the composer and scrolls when the content is taller than
			 * the tool window, so the repository list is visible without scrolling. */
			'.dshGitGraph_body[data-degraded=true]{display:flex;flex-direction:column;overflow-y:auto;overflow-x:hidden}',
			'.dshGitGraph_degradedInner{display:flex;flex-direction:column;align-items:center;width:100%;',
			'margin:auto 0;padding:18px 16px 14px;gap:6px;box-sizing:border-box}',
			'.dshGitGraph_degradedInner>.dshGitGraph_statePanel{flex:none;padding:10px 16px 14px;min-height:0}',
			'.dshGitGraph_degradedInner>.dshGitGraph_stateCode{align-self:center;max-width:520px;padding-bottom:2px;',
			'text-align:center}',

			/* Changed-file status letters. */
			'.dshGitGraph_statusA{color:var(--gg-status-add)}',
			'.dshGitGraph_statusM{color:var(--gg-status-modify)}',
			'.dshGitGraph_statusD{color:var(--gg-status-delete)}',
			'.dshGitGraph_statusR{color:var(--gg-status-rename)}',
			'.dshGitGraph_statusC{color:var(--gg-status-copy)}',
			'.dshGitGraph_statusT{color:var(--gg-status-type)}',
			'.dshGitGraph_statusQ{color:var(--dsw-alias-label-caption)}',

			/* Skeleton: three column placeholders for the very first paint. */
			'.dshGitGraph_skeleton{display:flex;flex:1;min-height:0;gap:0}',
			'.dshGitGraph_skCol{display:flex;flex-direction:column;gap:6px;padding:10px 8px;min-width:0}',
			'.dshGitGraph_skCol[data-col=refs]{flex:none;border-right:.5px solid var(--dsw-alias-border-l3)}',
			'.dshGitGraph_skCol[data-col=list]{flex:1}',
			'.dshGitGraph_skCol[data-col=detail]{flex:none;border-left:.5px solid var(--dsw-alias-border-l3);',
			'padding:14px 14px;gap:8px}',
			'.dshGitGraph_skBlock{border-radius:4px;background:var(--dsw-alias-bg-skeleton);',
			'animation:dshGitGraphPulse 1.5s ease-in-out infinite;flex:none}',
			'@keyframes dshGitGraphPulse{0%,100%{opacity:.55}50%{opacity:1}}',
			'@media (prefers-reduced-motion:reduce){.dshGitGraph_skBlock{animation:none}',
			'.dshGitGraph_iconBtn[data-spinning=true] svg{animation:none}}',
		]
			.concat(LANE_COLORS.map((color, index) => `.dshGitGraph_stroke${index}{stroke:var(--gg-lane-${index})}`))
			.concat(LANE_COLORS.map((color, index) => `.dshGitGraph_fill${index}{fill:var(--gg-lane-${index})}`))
			.join('');

		/* ------------------------------------------------------------------ */
		/* Pure logic: commit lane graph                                       */
		/* ------------------------------------------------------------------ */

		/**
		 * Assign every commit a lane and describe the edge segments crossing its
		 * row, from a newest→oldest topologically ordered list.
		 *
		 * Lanes hold the SHA the row below is expected to reach; a commit claims
		 * the lane already expecting it (or opens one), its first parent continues
		 * that lane, further parents fork right (or join a lane already expecting
		 * them), and every uninvolved lane passes straight through. Freed lanes are
		 * reused before the list grows, and trailing free lanes are trimmed, so the
		 * graph stays as narrow as the history allows. The result depends only on
		 * the input order, never on time or global state.
		 *
		 * @param commits - `{ sha, parents }` records in display order.
		 * @returns `{ rows, laneCount }`; each row carries `nodeLane`, `color`,
		 *   `segments` (`through` | `in` | `merge-in` | `out` | `branch-out` |
		 *   `join-out`) and the shared `laneCount` for column alignment.
		 */
		function assignLanes(commits) {
			const list = Array.isArray(commits) ? commits : [];
			/** @type {{ sha: string | null }[]} */
			const lanes = [];
			const rows = [];
			let laneCount = 0;

			/** First free lane, else append one. */
			const allocateLane = () => {
				for (let index = 0; index < lanes.length; index += 1) {
					if (lanes[index].sha === null) {
						lanes[index].sha = '';
						return index;
					}
				}
				lanes.push({ sha: '' });
				return lanes.length - 1;
			};

			for (const commit of list) {
				const sha = typeof commit?.sha === 'string' ? commit.sha : '';
				const hits = [];
				for (let index = 0; index < lanes.length; index += 1) {
					if (sha !== '' && lanes[index].sha === sha) hits.push(index);
				}
				let nodeLane;
				let fresh = false;
				if (hits.length > 0) {
					nodeLane = hits[0];
				} else {
					nodeLane = allocateLane();
					lanes[nodeLane].sha = sha;
					fresh = true;
				}

				const segments = [];
				for (const lane of hits) {
					segments.push(lane === nodeLane
						? { kind: 'in', fromLane: lane, toLane: nodeLane, color: lane % LANE_COLORS.length }
						: { kind: 'merge-in', fromLane: lane, toLane: nodeLane, color: lane % LANE_COLORS.length });
				}
				for (let index = 0; index < lanes.length; index += 1) {
					if (index === nodeLane || hits.includes(index) || lanes[index].sha === null) continue;
					segments.push({ kind: 'through', fromLane: index, toLane: index, color: index % LANE_COLORS.length });
				}

				const rawParents = Array.isArray(commit?.parents) ? commit.parents : [];
				const parents = [];
				for (const parent of rawParents) {
					if (typeof parent === 'string' && parent.length > 0 && !parents.includes(parent)) parents.push(parent);
				}

				/* Lanes that expected this commit but do not carry on are dead now. */
				for (const lane of hits) {
					if (lane !== nodeLane) lanes[lane].sha = null;
				}

				if (parents.length === 0) {
					lanes[nodeLane].sha = null;
				} else {
					const firstParent = parents[0];
					let joinLane = -1;
					for (let index = 0; index < lanes.length; index += 1) {
						if (index !== nodeLane && lanes[index].sha === firstParent) {
							joinLane = index;
							break;
						}
					}
					if (joinLane >= 0) {
						segments.push({ kind: 'join-out', fromLane: nodeLane, toLane: joinLane, color: nodeLane % LANE_COLORS.length });
						lanes[nodeLane].sha = null;
					} else {
						lanes[nodeLane].sha = firstParent;
						segments.push({ kind: 'out', fromLane: nodeLane, toLane: nodeLane, color: nodeLane % LANE_COLORS.length });
					}
					for (let index = 1; index < parents.length; index += 1) {
						const parent = parents[index];
						let existing = -1;
						for (let lane = 0; lane < lanes.length; lane += 1) {
							if (lanes[lane].sha === parent) {
								existing = lane;
								break;
							}
						}
						if (existing >= 0) {
							segments.push({ kind: 'branch-out', fromLane: nodeLane, toLane: existing, color: existing % LANE_COLORS.length });
							continue;
						}
						const lane = allocateLane();
						lanes[lane].sha = parent;
						segments.push({ kind: 'branch-out', fromLane: nodeLane, toLane: lane, color: lane % LANE_COLORS.length });
					}
				}

				while (lanes.length > 0 && lanes[lanes.length - 1].sha === null) lanes.pop();

				let rowLanes = nodeLane;
				for (const segment of segments) rowLanes = Math.max(rowLanes, segment.fromLane, segment.toLane);
				laneCount = Math.max(laneCount, rowLanes + 1);
				rows.push({
					sha,
					nodeLane,
					fresh,
					color: nodeLane % LANE_COLORS.length,
					segments,
					rowLaneCount: rowLanes + 1,
				});
			}

			for (const row of rows) row.laneCount = laneCount;
			return { rows, laneCount };
		}

		/**
		 * SVG path for one graph segment inside a row.
		 * @param segment - one `assignLanes` segment.
		 * @param rowHeight - row height in px.
		 * @returns the path `d` attribute.
		 */
		function graphSegmentPath(segment, rowHeight) {
			const mid = rowHeight / 2;
			const x1 = LANE_PAD + segment.fromLane * LANE_WIDTH;
			const x2 = LANE_PAD + segment.toLane * LANE_WIDTH;
			switch (segment.kind) {
				case 'through':
					return `M${x1} 0V${rowHeight}`;
				case 'in':
					return `M${x1} 0V${mid}`;
				case 'out':
					return `M${x1} ${mid}V${rowHeight}`;
				case 'merge-in':
					return `M${x1} 0C${x1} ${mid * 0.62} ${x2} ${mid * 0.38} ${x2} ${mid}`;
				case 'branch-out':
				case 'join-out':
					return `M${x1} ${mid}C${x1} ${mid + mid * 0.62} ${x2} ${rowHeight - mid * 0.38} ${x2} ${rowHeight}`;
				default:
					return '';
			}
		}

		/** Pixel width of the graph gutter for a lane count. */
		function graphWidth(laneCount) {
			const lanes = Math.min(Math.max(1, laneCount), MAX_GRAPH_LANES);
			return LANE_PAD * 2 + (lanes - 1) * LANE_WIDTH;
		}

		/* ------------------------------------------------------------------ */
		/* Pure logic: viewport measurement                                   */
		/* ------------------------------------------------------------------ */

		/** Hard lower bound of the tool window height, even in tiny viewports. */
		const MIN_VIEW_HEIGHT = 300;
		/** Gap kept between the composer and the bottom of the tool window. */
		const COMPOSER_GAP = 6;
		/** Inset of the composer's top edge used as the bottom limit. */
		const COMPOSER_INSET = 8;
		/** A floating composer input is at least this tall / wide. */
		const COMPOSER_MIN_HEIGHT = 20;
		const COMPOSER_MIN_WIDTH = 200;

		/**
		 * Viewport-space top of the lowest visible composer-sized input.
		 *
		 * The conversation page overlays the message composer on top of the
		 * content area, so the view must stop above it. Only inputs large enough
		 * to be the composer count (small buttons/inputs are ignored), and only
		 * those below the view root and inside the viewport.
		 * @param rects - `{ top, width, height }` in viewport space.
		 * @param rootTop - viewport-space top of the tool window.
		 * @param viewportHeight - `window.innerHeight` (0 when unknown).
		 * @returns the composer top, or null when no composer was found.
		 */
		function composerTopFromRects(rects, rootTop, viewportHeight) {
			const top = Number(rootTop);
			const viewport = Number(viewportHeight);
			const hasRoot = Number.isFinite(top) && top >= 0;
			const hasViewport = Number.isFinite(viewport) && viewport > 0;
			let found = null;
			for (const rect of Array.isArray(rects) ? rects : []) {
				const rectTop = Number(rect?.top);
				const height = Number(rect?.height);
				const width = Number(rect?.width);
				if (!Number.isFinite(rectTop) || !Number.isFinite(height) || !Number.isFinite(width)) continue;
				if (height < COMPOSER_MIN_HEIGHT || width < COMPOSER_MIN_WIDTH) continue;
				if (hasRoot && !(rectTop > top + 50)) continue;
				if (hasViewport && !(rectTop < viewport)) continue;
				if (found === null || rectTop > found) found = rectTop;
			}
			return found;
		}

		/**
		 * Available height of the tool window, clamped above the floating composer.
		 *
		 * The old measurement only looked at the nearest scrolling ancestor (whose
		 * clientHeight is the whole viewport) or at `innerHeight`; both let the view
		 * run underneath the overlaid composer. The candidate is therefore the
		 * smaller of the ancestor's usable height and the space left above the
		 * composer, with a hard floor so the view stays usable.
		 * @param options - `{ viewportHeight, rootTop, ancestorHeight, composerTop }`;
		 *   `ancestorHeight` is the usable height inside the scrolling ancestor
		 *   (0 when there is none) and `composerTop` is viewport-space or null.
		 * @returns the rounded height in px (>= MIN_VIEW_HEIGHT), or 0 when there
		 *   is nothing to measure.
		 */
		function clampAvailableHeight(options) {
			const viewportHeight = Number(options?.viewportHeight);
			const rootTopValue = Number(options?.rootTop);
			const ancestorHeight = Number(options?.ancestorHeight);
			const composerTopValue = options?.composerTop === null || options?.composerTop === undefined
				? null
				: Number(options.composerTop);
			const rootTop = Number.isFinite(rootTopValue) && rootTopValue > 0 ? rootTopValue : 0;
			const viewport = Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : 0;
			const ancestor = Number.isFinite(ancestorHeight) && ancestorHeight > 0 ? ancestorHeight : 0;
			const composer = composerTopValue !== null && Number.isFinite(composerTopValue) && composerTopValue > 0
				? composerTopValue
				: null;
			let candidate = Number.POSITIVE_INFINITY;
			if (composer !== null) candidate = composer - COMPOSER_INSET - rootTop - COMPOSER_GAP;
			else if (viewport > 0) candidate = viewport - rootTop - COMPOSER_GAP;
			if (ancestor > 0) candidate = Math.min(candidate, ancestor);
			if (!Number.isFinite(candidate)) return 0;
			return Math.max(MIN_VIEW_HEIGHT, Math.round(candidate));
		}

		/**
		 * Viewport-space top of the floating message composer, when the page has
		 * one. Inputs inside the tool window itself (the commit search box) are
		 * ignored; only composer-sized inputs count.
		 */
		function measureComposerTop(element, rootTop) {
			if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return null;
			if (typeof window === 'undefined' || typeof window.innerHeight !== 'number') return null;
			let nodes;
			try {
				nodes = document.querySelectorAll('[role="textbox"],textarea,[contenteditable="true"]');
			} catch (error) {
				return null;
			}
			const rects = [];
			for (const node of nodes) {
				if (node === null || node === undefined || typeof node.getBoundingClientRect !== 'function') continue;
				if (node === element) continue;
				if (typeof element?.contains === 'function' && element.contains(node)) continue;
				const box = node.getBoundingClientRect();
				rects.push({ top: box.top, width: box.width, height: box.height });
			}
			return composerTopFromRects(rects, rootTop, window.innerHeight);
		}

		/* ------------------------------------------------------------------ */
		/* Pure logic: formatting and selection                                */
		/* ------------------------------------------------------------------ */

		/** Two-digit zero padding. */
		function pad2(value) {
			return value < 10 ? `0${value}` : String(value);
		}

		/** Short form of a commit id. */
		function shortSha(sha, length) {
			const text = typeof sha === 'string' ? sha : '';
			const size = typeof length === 'number' && length > 0 ? length : 7;
			return text.slice(0, size);
		}

		/** A local-time `YYYY/MM/DD HH:mm` string, or `''` for a missing time. */
		function formatDateTime(seconds) {
			const value = Number(seconds);
			if (!Number.isFinite(value) || value <= 0) return '';
			const date = new Date(value * 1000);
			return `${date.getFullYear()}/${pad2(date.getMonth() + 1)}/${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
		}

		/** Whole local calendar days from `from` to `to`. */
		function calendarDays(from, to) {
			const a = new Date(from.getFullYear(), from.getMonth(), from.getDate()).getTime();
			const b = new Date(to.getFullYear(), to.getMonth(), to.getDate()).getTime();
			return Math.round((b - a) / DAY_MS);
		}

		/**
		 * Table date column: relative below a week, then an absolute date.
		 * @param seconds - commit time, Unix seconds.
		 * @param nowSeconds - injectable clock for tests.
		 * @param tr - translator.
		 * @returns the display text.
		 */
		function formatTime(seconds, nowSeconds, tr) {
			const translate = typeof tr === 'function' ? tr : fallbackTranslate;
			const value = Number(seconds);
			if (!Number.isFinite(value) || value <= 0) return '';
			const now = Number.isFinite(Number(nowSeconds)) ? Number(nowSeconds) : Math.floor(Date.now() / 1000);
			const diff = Math.max(0, now - value);
			if (diff < 60) return translate('time.justNow');
			if (diff < 3600) return translate('time.minutesAgo', { count: Math.floor(diff / 60) });
			if (diff < 86400) return translate('time.hoursAgo', { count: Math.floor(diff / 3600) });
			const date = new Date(value * 1000);
			const nowDate = new Date(now * 1000);
			const days = calendarDays(date, nowDate);
			if (days === 1) return `${translate('time.yesterday')} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
			if (days < RELATIVE_MAX_DAYS) return translate('time.daysAgo', { count: Math.max(1, days) });
			const time = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
			if (date.getFullYear() === nowDate.getFullYear()) {
				return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${time}`;
			}
			return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${time}`;
		}

		/** Head-truncated path for narrow surfaces; the title attribute keeps the rest. */
		function shortPath(path, max) {
			const text = typeof path === 'string' ? path : '';
			const limit = typeof max === 'number' && max > 8 ? max : PATH_MAX;
			if (text.length <= limit) return text;
			return `…${text.slice(text.length - (limit - 1))}`;
		}

		/** Status letter and tone of one changed file. */
		function statusMeta(status) {
			const letter = typeof status === 'string' && status.length > 0 ? status.charAt(0).toUpperCase() : 'M';
			const known = letter === 'A' || letter === 'M' || letter === 'D' || letter === 'R' || letter === 'C' || letter === 'T';
			const tone = known ? letter : 'Q';
			return { letter, tone, key: `status.${tone}` };
		}

		/** Case-insensitive, token-wise commit filter over subject, body, author and SHA. */
		function filterCommits(commits, query) {
			const list = Array.isArray(commits) ? commits : [];
			const raw = typeof query === 'string' ? query.trim().toLowerCase() : '';
			if (raw === '') return list.slice();
			const tokens = raw.split(/\s+/u).filter((token) => token.length > 0);
			if (tokens.length === 0) return list.slice();
			return list.filter((commit) => {
				const author = commit?.author ?? {};
				const haystack = [
					commit?.subject ?? '',
					commit?.body ?? '',
					author?.name ?? '',
					author?.email ?? '',
					commit?.sha ?? '',
					shortSha(commit?.sha),
				]
					.join('\n')
					.toLowerCase();
				return tokens.every((token) => haystack.includes(token));
			});
		}

		/** Value of the `ref` log parameter for a refs-tree filter. */
		function refFilterValue(filter) {
			return filter !== null && typeof filter === 'object' && typeof filter.ref === 'string' ? filter.ref : undefined;
		}

		/**
		 * Turn the `refs` response into the left column's three collapsible groups.
		 * Every row carries the `refs/...` value the `log` call filters by, an icon
		 * key and the HEAD/ahead/behind decoration.
		 * @param value - `op=refs` value, tolerating a missing or partial body.
		 * @returns `{ head, groups }`, groups only for non-empty classes.
		 */
		function buildRefsTree(value) {
			const branches = Array.isArray(value?.branches) ? value.branches : [];
			const remotes = Array.isArray(value?.remotes) ? value.remotes : [];
			const tags = Array.isArray(value?.tags) ? value.tags : [];
			const branchItems = branches.map((branch) => {
				const name = typeof branch?.name === 'string' ? branch.name : '';
				return {
					key: `refs/heads/${name}`,
					kind: 'branch',
					icon: 'branch',
					name,
					ref: `refs/heads/${name}`,
					sha: typeof branch?.sha === 'string' ? branch.sha : undefined,
					isHead: branch?.isHead === true,
					ahead: Number(branch?.ahead) || 0,
					behind: Number(branch?.behind) || 0,
					title: typeof branch?.subject === 'string' ? branch.subject : '',
				};
			});
			const remoteItems = remotes.map((remote) => {
				const name = typeof remote?.name === 'string' ? remote.name : '';
				return {
					key: `refs/remotes/${name}`,
					kind: 'remote',
					icon: 'remote',
					name,
					ref: `refs/remotes/${name}`,
					sha: typeof remote?.sha === 'string' ? remote.sha : undefined,
					isHead: remote?.isHead === true,
					ahead: Number(remote?.ahead) || 0,
					behind: Number(remote?.behind) || 0,
					title: typeof remote?.subject === 'string' ? remote.subject : '',
				};
			});
			const tagItems = tags.map((tag) => {
				const name = typeof tag?.name === 'string' ? tag.name : '';
				return {
					key: `refs/tags/${name}`,
					kind: 'tag',
					icon: 'tag',
					name,
					ref: `refs/tags/${name}`,
					sha: typeof tag?.sha === 'string' ? tag.sha : undefined,
					isHead: false,
					ahead: 0,
					behind: 0,
					title: typeof tag?.subject === 'string' ? tag.subject : '',
				};
			});
			const groups = [];
			if (branchItems.length > 0) groups.push({ key: 'branches', labelKey: 'refs.branches', items: branchItems });
			if (remoteItems.length > 0) groups.push({ key: 'remotes', labelKey: 'refs.remotes', items: remoteItems });
			if (tagItems.length > 0) groups.push({ key: 'tags', labelKey: 'refs.tags', items: tagItems });
			return { head: value?.head ?? null, groups };
		}

		/** Index of a SHA inside a commit list, or -1. */
		function indexOfSha(commits, sha) {
			if (typeof sha !== 'string' || sha === '' || !Array.isArray(commits)) return -1;
			for (let index = 0; index < commits.length; index += 1) {
				if (commits[index]?.sha === sha) return index;
			}
			return -1;
		}

		/**
		 * Commit that should be selected after a log load: the remembered SHA when
		 * it is still in the list, else the repository HEAD, else the newest row.
		 */
		function pickDefaultSha(commits, headSha, preferred) {
			const list = Array.isArray(commits) ? commits : [];
			if (indexOfSha(list, preferred) >= 0) return preferred;
			if (indexOfSha(list, headSha) >= 0) return headSha;
			return list.length > 0 ? list[0]?.sha ?? null : null;
		}

		/** Selection index moved by one keyboard step, clamped to the list. */
		function nextSelectedIndex(currentIndex, delta, total) {
			const count = Number(total) || 0;
			if (count <= 0) return -1;
			if (!Number.isFinite(currentIndex) || currentIndex < 0) return delta < 0 ? count - 1 : 0;
			return Math.max(0, Math.min(count - 1, currentIndex + (Number(delta) || 0)));
		}

		/** Merge a newly loaded log page into the accumulated list, deduplicated. */
		function mergeCommitPages(existing, page) {
			const merged = Array.isArray(existing) ? existing.slice() : [];
			const seen = new Set(merged.map((commit) => commit?.sha));
			for (const commit of Array.isArray(page) ? page : []) {
				if (seen.has(commit?.sha)) continue;
				seen.add(commit?.sha);
				merged.push(commit);
			}
			return merged;
		}

		/** Whether the scroll position is close enough to the end to page in more. */
		function shouldRequestMore(scrollTop, clientHeight, scrollHeight) {
			const top = Number(scrollTop) || 0;
			const height = Number(clientHeight) || 0;
			const total = Number(scrollHeight) || 0;
			if (total <= height) return false;
			return total - (top + height) < ROW_HEIGHT * 6;
		}

		/**
		 * Visible slice of a long list for windowed rendering.
		 * @returns `{ start, end, topPad, bottomPad, virtual }`.
		 */
		function computeWindow(scrollTop, viewportHeight, rowHeight, total, overscan) {
			const count = Math.max(0, Number(total) || 0);
			const height = Number(rowHeight) > 0 ? Number(rowHeight) : ROW_HEIGHT;
			const viewport = Math.max(0, Number(viewportHeight) || 0);
			const buffer = Math.max(0, Number(overscan) || 0);
			if (count === 0) return { start: 0, end: 0, topPad: 0, bottomPad: 0, virtual: false };
			const visible = Math.max(1, Math.ceil(viewport / height));
			if (count <= VIRTUAL_THRESHOLD) return { start: 0, end: count, topPad: 0, bottomPad: 0, virtual: false };
			const start = Math.max(0, Math.min(count - 1, Math.floor((Number(scrollTop) || 0) / height) - buffer));
			const end = Math.min(count, start + visible + buffer * 2);
			return { start, end, topPad: start * height, bottomPad: (count - end) * height, virtual: true };
		}

		/** Grid template shared by the table header and its rows. */
		function columnTemplate(graphGutter, compact) {
			const author = compact ? 72 : AUTHOR_WIDTH;
			const date = compact ? 78 : DATE_WIDTH;
			const sha = compact ? 56 : SHA_WIDTH;
			return `${graphGutter}px minmax(0,1fr) ${author}px ${date}px ${sha}px`;
		}

		/** Additions and deletions of one commit, tolerating missing stats. */
		function formatStats(stats) {
			const additions = Number(stats?.additions);
			const deletions = Number(stats?.deletions);
			return {
				additions: Number.isFinite(additions) ? additions : 0,
				deletions: Number.isFinite(deletions) ? deletions : 0,
			};
		}

		/** Count refs of one kind decorating a commit. */
		function countRefsOfKind(commit, kind) {
			const refs = Array.isArray(commit?.refs) ? commit.refs : [];
			let count = 0;
			for (const ref of refs) {
				if (ref?.kind === kind) count += 1;
			}
			return count;
		}

		/** Cache key of one file diff inside a commit. */
		function diffPathKey(sha, path) {
			return `${typeof sha === 'string' ? sha : ''}\u0000${typeof path === 'string' ? path : ''}`;
		}

		/** Split a file path into the dimmed directory and the filename. */
		function splitFilePath(path) {
			const text = typeof path === 'string' ? path : '';
			const index = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'));
			if (index < 0) return { dir: '', base: text };
			return { dir: text.slice(0, index + 1), base: text.slice(index + 1) };
		}

		/** A small insertion-ordered map with a capacity; oldest keys leave first. */
		function createLru(limit) {
			const capacity = Math.max(1, Number(limit) || 16);
			const map = new Map();
			return {
				get(key) {
					return map.has(key) ? map.get(key) : undefined;
				},
				has(key) {
					return map.has(key);
				},
				set(key, value) {
					if (map.has(key)) map.delete(key);
					map.set(key, value);
					while (map.size > capacity) {
						const oldest = map.keys().next();
						if (oldest.done) break;
						map.delete(oldest.value);
					}
					return value;
				},
				clear() {
					map.clear();
				},
				get size() {
					return map.size;
				},
			};
		}

		/* ------------------------------------------------------------------ */
		/* Pure logic: host responses                                          */
		/* ------------------------------------------------------------------ */

		/** Error carrying the Host's stable code, message and optional cwd. */
		function GitGraphError(code, message, extra) {
			const error = new Error(typeof message === 'string' && message !== '' ? message : code);
			error.name = 'GitGraphError';
			error.code = typeof code === 'string' && code !== '' ? code : 'unknown';
			if (typeof extra?.cwd === 'string') error.cwd = extra.cwd;
			return error;
		}

		/** Validate one Host envelope, tolerating malformed bodies. */
		function parseEnvelope(payload) {
			if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
				return { ok: false, error: { code: 'bad-response', message: 'the response is not a JSON object' } };
			}
			if (payload.ok === true) return { ok: true, value: payload.value };
			const raw = payload.error;
			const error = raw !== null && typeof raw === 'object' ? raw : {};
			const result = {
				ok: false,
				error: {
					code: typeof error.code === 'string' && error.code !== '' ? error.code : 'unknown',
					message: typeof error.message === 'string' ? error.message : '',
				},
			};
			if (typeof error.cwd === 'string') result.error.cwd = error.cwd;
			return result;
		}

		/** Normalize any failure into `{ code, message, cwd? }` for the state panels. */
		function toDisplayError(error) {
			if (error === null || typeof error !== 'object') return { code: 'unknown', message: String(error ?? '') };
			const code = typeof error.code === 'string' && error.code !== '' ? error.code : error.name === 'AbortError' ? 'aborted' : 'unknown';
			return {
				code,
				message: typeof error.message === 'string' ? error.message : '',
				cwd: typeof error.cwd === 'string' ? error.cwd : undefined,
			};
		}

		/** The state a `repo` value describes. */
		function repoStatusOf(value) {
			if (value === null || typeof value !== 'object') return 'error';
			if (value.isRepo === false) return 'not-repo';
			if (value.empty === true) return 'empty';
			return 'ready';
		}

		/** Normalize a filesystem path for equality checks (Windows ignores case). */
		function normalizePathValue(path) {
			if (typeof path !== 'string') return '';
			return path.replace(/\\+/gu, '/').replace(/\/+$/u, '').toLowerCase();
		}

		/** Whether two paths point at the same directory, tolerating case and separators. */
		function samePath(left, right) {
			const a = normalizePathValue(left);
			const b = normalizePathValue(right);
			return a !== '' && a === b;
		}

		/** Last segment of a path, or '' when there is none. */
		function lastPathSegment(path) {
			const parts = (typeof path === 'string' ? path : '').split(/[\\/]+/u).filter((part) => part !== '');
			return parts.length > 0 ? parts[parts.length - 1] : '';
		}

		/** `cwdRepo` of an `op=repos` value (SPEC §3.6), defaulting a partial body. */
		function normalizeCwdRepo(value) {
			const raw = value?.cwdRepo;
			if (raw === null || typeof raw !== 'object') return { isRepo: false, root: null, head: null, empty: false };
			return {
				isRepo: raw.isRepo === true,
				root: typeof raw.root === 'string' ? raw.root : null,
				head: raw.head !== null && typeof raw.head === 'object' ? raw.head : null,
				empty: raw.empty === true,
			};
		}

		/** One repository record of an `op=repos` value, tolerating missing fields. */
		function normalizeRepoEntry(repo) {
			const path = typeof repo?.path === 'string' ? repo.path : '';
			const rel = typeof repo?.rel === 'string' && repo.rel !== '' ? repo.rel : lastPathSegment(path);
			const name = typeof repo?.name === 'string' && repo.name !== '' ? repo.name : lastPathSegment(rel);
			const depth = Number(repo?.depth);
			return {
				path,
				rel,
				name: name !== '' ? name : path,
				depth: Number.isFinite(depth) ? depth : 0,
				head: repo?.head !== null && typeof repo?.head === 'object' ? repo.head : null,
			};
		}

		/**
		 * Normalize the `op=repos` value (SPEC §3.6): the session cwd, whether it
		 * is itself a repository, and every repository found strictly below it.
		 * A malformed body degrades to "nothing found" instead of throwing.
		 */
		function normalizeReposValue(value) {
			const raw = Array.isArray(value?.repos) ? value.repos : [];
			const repos = [];
			for (const entry of raw) {
				const repo = normalizeRepoEntry(entry);
				if (repo.path !== '') repos.push(repo);
			}
			return {
				cwd: typeof value?.cwd === 'string' ? value.cwd : '',
				cwdRepo: normalizeCwdRepo(value),
				repos,
				scanned: value?.scanned !== null && typeof value?.scanned === 'object' ? value.scanned : null,
				limits: value?.limits !== null && typeof value?.limits === 'object' ? value.limits : null,
			};
		}

		/**
		 * The data both the toolbar dropdown and the not-a-repository list render:
		 * the session directory row, each discovered repository (with an `active`
		 * flag for the current selection) and the scan status.
		 * @param state - the component's `reposState`.
		 * @param pickedCwd - the explicitly selected repository directory, or null.
		 */
		function buildRepoMenu(state, pickedCwd) {
			const status = typeof state?.status === 'string' ? state.status : 'idle';
			const normalized = state?.value === null || state?.value === undefined ? null : normalizeReposValue(state.value);
			const activePath = typeof pickedCwd === 'string' && pickedCwd !== '' ? pickedCwd : null;
			const repos = (normalized?.repos ?? []).map((repo) => ({
				...repo,
				active: activePath !== null && samePath(repo.path, activePath),
			}));
			return {
				status,
				error: state?.error ?? null,
				cwd: normalized?.cwd ?? '',
				cwdRepo: normalized?.cwdRepo ?? normalizeCwdRepo(null),
				sessionActive: activePath === null,
				repos,
				count: repos.length,
				scanned: normalized?.scanned ?? null,
				limits: normalized?.limits ?? null,
			};
		}

		/** Human label of one repository HEAD (branch name, detached or unborn). */
		function describeRepoHead(head, tr) {
			const translate = typeof tr === 'function' ? tr : fallbackTranslate;
			if (head === null || head === undefined || typeof head !== 'object') return '';
			const name = typeof head.name === 'string' ? head.name : '';
			const sha = typeof head.shortSha === 'string' && head.shortSha !== '' ? head.shortSha : shortSha(head.sha);
			if (head.type === 'detached') {
				return sha === '' ? translate('repoMenu.detachedNoSha') : translate('repoMenu.detached', { sha });
			}
			if (head.type === 'unborn') {
				return name === '' ? translate('repoMenu.unborn') : translate('repoMenu.unbornBranch', { name });
			}
			return name;
		}

		/**
		 * Auto-selection rule (SPEC §2): when the session directory is not itself
		 * a repository and exactly one repository was discovered below it, that
		 * repository is selected automatically.
		 * @param options - `{ status, pickedCwd, cwdRepo, repos }` from `reposState`.
		 * @returns the repository path to select, or null.
		 */
		function shouldAutoSelectSingleRepo(options) {
			const { status, pickedCwd, cwdRepo, repos } = options ?? {};
			if (status !== 'ready') return null;
			if (typeof pickedCwd === 'string' && pickedCwd !== '') return null;
			if (cwdRepo === null || typeof cwdRepo !== 'object' || cwdRepo.isRepo !== false) return null;
			if (!Array.isArray(repos) || repos.length !== 1) return null;
			const path = repos[0]?.path;
			return typeof path === 'string' && path !== '' ? path : null;
		}

		/** Bounded session memory so a view switch restores the last selection. */
		const sessionMemory = new Map();

		/** Remember one patch of view state for a session, evicting the oldest. */
		function rememberSessionState(sessionId, patch) {
			if (typeof sessionId !== 'string' || sessionId === '') return;
			const current = sessionMemory.get(sessionId) ?? {};
			sessionMemory.set(sessionId, { ...current, ...patch });
			while (sessionMemory.size > SESSION_MEMORY_LIMIT) {
				const oldest = sessionMemory.keys().next();
				if (oldest.done) break;
				sessionMemory.delete(oldest.value);
			}
		}

		/** Recall the last view state of a session. */
		function recallSessionState(sessionId) {
			if (typeof sessionId !== 'string' || sessionId === '') return {};
			return sessionMemory.get(sessionId) ?? {};
		}

		/** Shared request caches: commit details by sha, file diffs by sha+path. */
		const commitCache = createLru(COMMIT_CACHE_LIMIT);
		const diffCache = createLru(DIFF_CACHE_LIMIT);

		/* ------------------------------------------------------------------ */
		/* Inline icons (own artwork, currentColor)                            */
		/* ------------------------------------------------------------------ */

		const ICONS = {
			branch: ['M5 2.5a1.75 1.75 0 1 0 0 3.5 1.75 1.75 0 0 0 0-3.5ZM5 6v6.2', 'M5 9.2a2.6 2.6 0 0 0 2.6 2.6h1.4a2 2 0 0 0 2-2V9', 'M11 2.5a1.75 1.75 0 1 0 0 3.5 1.75 1.75 0 0 0 0-3.5ZM11 6v2.2'],
			remote: ['M5 2.5a1.75 1.75 0 1 0 0 3.5 1.75 1.75 0 0 0 0-3.5ZM5 6v6.2', 'M5 9.2a2.6 2.6 0 0 0 2.6 2.6H11', 'M11 4.5a1.4 1.4 0 1 0 0 2.8 1.4 1.4 0 0 0 0-2.8Z', 'M11 7.3v4.4', 'M9.4 10.2 11 11.9l1.6-1.7'],
			tag: ['M2.6 7.4V3.2c0-.35.28-.62.62-.62h4.2c.17 0 .33.07.44.18l5.02 5.02a.62.62 0 0 1 0 .88l-3.78 3.78a.62.62 0 0 1-.88 0L3.2 7.84a.62.62 0 0 1-.18-.44Z', 'M5.1 5.1h.01'],
			commit: ['M2 8h3.2M10.8 8H14', 'M8 4.6a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 0 0 0-6.8Z'],
			person: ['M8 7.3a2.15 2.15 0 1 0 0-4.3 2.15 2.15 0 0 0 0 4.3Z', 'M3.7 13c0-2.1 1.9-3.5 4.3-3.5s4.3 1.4 4.3 3.5'],
			folder: ['M2 4.6c0-.6.5-1.1 1.1-1.1h2.5l1.2 1.4h5.1c.6 0 1.1.5 1.1 1.1v5.1c0 .6-.5 1.1-1.1 1.1H3.1c-.6 0-1.1-.5-1.1-1.1V4.6Z'],
			search: ['M7.2 2.4a4.8 4.8 0 1 0 0 9.6 4.8 4.8 0 0 0 0-9.6Z', 'M10.7 10.7 14 14'],
			refresh: ['M12.8 8a4.8 4.8 0 1 1-1.4-3.4', 'M12.9 2.6v3.1h-3.1'],
			close: ['M3.5 3.5 12.5 12.5', 'M12.5 3.5 3.5 12.5'],
			chevronRight: ['M6 3.5 10.5 8 6 12.5'],
			chevronDown: ['M3.5 6 8 10.5 12.5 6'],
			alert: ['M8 2.6 14 13H2L8 2.6Z', 'M8 6.3v3', 'M8 11.2h.01'],
			git: ['M2.2 8.2 8.2 2.2c.3-.3.8-.3 1.1 0l2.4 2.4-1.5 1.5-1.5-1.5-1.1 1.1 1.5 1.5-1.4 1.4-1.5-1.5-4 4V8.2Z', 'M10.3 8.9a1.5 1.5 0 1 0 2.2 2.1 1.5 1.5 0 0 0-2.2-2.1Z'],
			arrowUp: ['M8 12.5V3.5', 'M4.5 7 8 3.5 11.5 7'],
			arrowDown: ['M8 3.5v9', 'M4.5 9 8 12.5 11.5 9'],
			check: ['M2.8 8.4 6.2 11.8 13.2 4.8'],
			dot: ['M8 5.6a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 0 0 0-4.8Z'],
			file: ['M4 2.2h5l3 3v8.6H4V2.2Z', 'M8.8 2.4v3h3'],
			spinner: ['M8 2.4a5.6 5.6 0 1 0 5.6 5.6'],
		};

		/**
		 * One inline icon.
		 * @param name - key of `ICONS`.
		 * @param size - square px size.
		 * @param className - optional extra class.
		 * @returns an SVG element.
		 */
		function icon(name, size, className) {
			const paths = ICONS[name] ?? ICONS.dot;
			const dimension = typeof size === 'number' ? size : 14;
			return h(
				'svg',
				{
					viewBox: '0 0 16 16',
					width: dimension,
					height: dimension,
					className,
					'aria-hidden': true,
					focusable: false,
					fill: 'none',
					stroke: 'currentColor',
					strokeWidth: 1.35,
					strokeLinecap: 'round',
					strokeLinejoin: 'round',
				},
				paths.map((d, index) => h('path', { key: index, d })),
			);
		}

		/* ------------------------------------------------------------------ */
		/* Host data access                                                    */
		/* ------------------------------------------------------------------ */

		/**
		 * One same-origin JSON client for the Host half. The route is resolved
		 * against `document.baseURI`, exactly like the shipped file-upload client,
		 * so Electron file pages, the Web GUI and a proxied deployment all work
		 * without a hard-coded host or port.
		 * @param sessionId - session whose working directory the Host resolves.
		 * @returns `{ request }`, where `request(op, params, signal)` maps an
		 *   invalid envelope or transport failure to a `GitGraphError`.
		 */
		function createGitApi(sessionId) {
			const request = async (op, params, signal) => {
				const base = typeof document !== 'undefined' && typeof document.baseURI === 'string' && document.baseURI !== ''
					? document.baseURI
					: 'http://localhost/';
				const url = new URL('api/plugin/git-graph', base);
				url.searchParams.set('op', op);
				if (typeof sessionId === 'string' && sessionId !== '') url.searchParams.set('sessionId', sessionId);
				const source = params ?? {};
				for (const key of Object.keys(source)) {
					const value = source[key];
					if (value === undefined || value === null || value === '') continue;
					url.searchParams.set(key, String(value));
				}
				let response;
				try {
					response = await fetch(url, {
						method: 'GET',
						credentials: 'include',
						signal,
						headers: { accept: 'application/json' },
					});
				} catch (error) {
					if (error?.name === 'AbortError') throw error;
					throw GitGraphError('network-error', typeof error?.message === 'string' ? error.message : 'network error');
				}
				let payload = null;
				try {
					payload = await response.json();
				} catch (error) {
					payload = null;
				}
				if (payload === null) {
					if (response.ok === false) throw GitGraphError(`http-${response.status}`, `HTTP ${response.status}`);
					throw GitGraphError('bad-response', 'the response body is not JSON');
				}
				const envelope = parseEnvelope(payload);
				if (!envelope.ok) {
					throw GitGraphError(envelope.error.code, envelope.error.message, { cwd: envelope.error.cwd });
				}
				return envelope.value;
			};
			return { request };
		}

		/* ------------------------------------------------------------------ */
		/* Presentational pieces                                               */
		/* ------------------------------------------------------------------ */

		/** One commit row's graph gutter: pass-through lanes, edges, node, HEAD ring. */
		function GraphCell({ row, isHead, laneCount }) {
			const gutter = graphWidth(laneCount);
			const nodeX = LANE_PAD + row.nodeLane * LANE_WIDTH;
			const mid = ROW_HEIGHT / 2;
			return h(
				'svg',
				{
					className: 'dshGitGraph_graphSvg',
					width: gutter,
					height: ROW_HEIGHT,
					viewBox: `0 0 ${gutter} ${ROW_HEIGHT}`,
					'aria-hidden': true,
					focusable: false,
				},
				row.segments.map((segment, index) => h('path', {
					key: index,
					className: `dshGitGraph_stroke${segment.color}`,
					d: graphSegmentPath(segment, ROW_HEIGHT),
					fill: 'none',
					strokeWidth: 1.65,
					strokeLinecap: 'round',
				})),
				isHead
					? h('circle', {
						key: 'ring',
						className: `dshGitGraph_stroke${row.color} dshGitGraph_headRing`,
						cx: nodeX,
						cy: mid,
						r: 5.4,
						strokeWidth: 1.1,
					})
					: null,
				h('circle', { key: 'node', className: `dshGitGraph_fill${row.color}`, cx: nodeX, cy: mid, r: 3.1 }),
			);
		}

		/**
		 * Ref pills decorating one commit row. Only whole pills are rendered: the
		 * count that fits the row budget is shown, the rest collapse into a `+N`
		 * counter whose tooltip lists them.
		 */
		function RefPills({ refs, budget }) {
			const list = Array.isArray(refs) ? refs : [];
			if (list.length === 0) return null;
			const plan = planPills(list, budget);
			const hiddenNames = plan.hidden
				.map((ref) => (typeof ref?.name === 'string' ? ref.name : ''))
				.filter((name) => name !== '');
			const counter = plan.extra > 0
				? h(
					'span',
					{
						key: 'extra',
						className: 'dshGitGraph_pill dshGitGraph_pillRemote',
						title: hiddenNames.join('、'),
					},
					`+${plan.extra}`,
				)
				: null;
			if (plan.shown.length === 0) {
				return counter === null ? null : h('span', { className: 'dshGitGraph_pills' }, counter);
			}
			return h(
				'span',
				{ className: 'dshGitGraph_pills' },
				plan.shown.map((ref, index) => {
					const kind = ref?.kind === 'tag' ? 'tag' : ref?.kind === 'remote' ? 'remote' : 'branch';
					const tone = kind === 'tag' ? 'Tag' : kind === 'remote' ? 'Remote' : 'Branch';
					return h(
						'span',
						{ key: `pill-${index}`, className: `dshGitGraph_pill dshGitGraph_pill${tone}`, title: ref?.name ?? '' },
						ref?.head === true
							? h('span', { key: 'dot', className: 'dshGitGraph_headDot', style: { marginLeft: 0 }, 'aria-hidden': true })
							: null,
						icon(kind === 'tag' ? 'tag' : 'branch', 9),
						typeof ref?.name === 'string' ? ref.name : '',
					);
				}),
				counter,
			);
		}

		/** Collapsible refs tree: local branches, remote branches and tags. */
		function RefsTree({ tree, filter, onSelect, translate, drawer, onClose, style }) {
			const [collapsed, setCollapsed] = React.useState({});
			const currentKey = filter?.key ?? null;
			const groups = Array.isArray(tree?.groups) ? tree.groups : [];
			const toggle = (key) => setCollapsed((previous) => ({ ...previous, [key]: previous[key] !== true }));
			const row = (item) => h(
				'button',
				{
					key: item.key,
					type: 'button',
					className: 'dshGitGraph_refRow',
					'aria-current': currentKey === item.key ? 'true' : 'false',
					'data-head': item.isHead === true ? 'true' : 'false',
					title: item.title !== undefined && item.title !== '' ? item.title : item.name,
					onClick: () => onSelect(currentKey === item.key ? null : item),
				},
				icon(item.icon, 13),
				h('span', { className: 'dshGitGraph_refName' }, item.name),
				item.isHead
					? h('span', { key: 'head', className: 'dshGitGraph_headDot', 'aria-hidden': true })
					: item.ahead > 0 && item.behind > 0
						? h('span', { key: 'ab', className: 'dshGitGraph_refAhead' }, `↑${item.ahead} ↓${item.behind}`)
						: item.ahead > 0
							? h('span', { key: 'a', className: 'dshGitGraph_refAhead' }, `↑${item.ahead}`)
							: item.behind > 0
								? h('span', { key: 'b', className: 'dshGitGraph_refAhead' }, `↓${item.behind}`)
								: null,
			);
			return h(
				'aside',
				{
					className: 'dshGitGraph_refs',
					style,
					'data-drawer': drawer === true ? 'true' : 'false',
					role: 'navigation',
					'aria-label': translate('a11y.refs'),
				},
				h(
					'div',
					{ className: 'dshGitGraph_refsHead' },
					h('span', null, translate('refs.title')),
					drawer === true
						? h(
							'button',
							{
								type: 'button',
								className: 'dshGitGraph_iconBtn',
								style: { marginLeft: 'auto', width: 20, height: 20 },
								title: translate('toolbar.refsPanel'),
								'aria-label': translate('toolbar.refsPanel'),
								onClick: onClose,
							},
							icon('close', 12),
						)
						: null,
				),
				h(
					'button',
					{
						type: 'button',
						className: 'dshGitGraph_allRow',
						'aria-current': currentKey === null ? 'true' : 'false',
						onClick: () => onSelect(null),
					},
					icon('commit', 13),
					h('span', { className: 'dshGitGraph_refName' }, translate('refs.all')),
				),
				groups.length === 0
					? h('div', { className: 'dshGitGraph_refEmpty' }, translate('refs.empty'))
					: groups.map((group) => {
						const isOpen = collapsed[group.key] !== true;
						return h(
							'div',
							{ key: group.key, className: 'dshGitGraph_refGroup' },
							h(
								'button',
								{
									type: 'button',
									className: 'dshGitGraph_refGroupHead',
									'aria-expanded': isOpen,
									onClick: () => toggle(group.key),
								},
								icon(isOpen ? 'chevronDown' : 'chevronRight', 10),
								h('span', null, translate(group.labelKey)),
								h('span', { className: 'dshGitGraph_refCount' }, String(group.items.length)),
							),
							isOpen ? group.items.map(row) : null,
						);
					}),
			);
		}

		/** Pill geometry estimates, in px: enough to never squeeze a trailing pill. */
		const PILL_ICON_SPACE = 12;
		const PILL_CHAR_WIDTH = 5.9;
		const PILL_H_PADDING = 10;
		const PILL_GAP = 4;
		const PILL_COUNTER_WIDTH = 26;
		const PILL_BUDGET_CAP = 280;

		/** Whether an author name is a pure number, which gets a person glyph. */
		function isNumericName(name) {
			const text = typeof name === 'string' ? name.trim() : '';
			return text !== '' && /^[0-9]+$/u.test(text);
		}

		/** Whether a name contains CJK ideographs, whose avatar is one glyph. */
		function hasCjkName(name) {
			const text = typeof name === 'string' ? name : '';
			return /[\u3400-\u9fff\uf900-\ufaff]/u.test(text);
		}

		/** One-line typographic initials avatar; a numeric name returns '' (glyph). */
		function initialsOf(name) {
			const text = typeof name === 'string' ? name.trim() : '';
			if (text === '') return '?';
			if (isNumericName(text)) return '';
			const words = text.split(/\s+/u).filter((word) => word.length > 0);
			if (words.length > 1) return `${words[0][0] ?? ''}${words[1][0] ?? ''}`.toUpperCase();
			if (hasCjkName(text)) return Array.from(text)[0] ?? '?';
			return Array.from(text).slice(0, 2).join('').toUpperCase();
		}

		/** Estimated rendered width of one ref pill, from its name length. */
		function estimatePillWidth(name) {
			const text = typeof name === 'string' ? name : '';
			return PILL_H_PADDING + PILL_ICON_SPACE + Math.ceil(text.length * PILL_CHAR_WIDTH);
		}

		/**
		 * Decide how many ref pills fit beside a commit subject.
		 *
		 * Pills are never shrunk, so a row can only ever show whole pills: the
		 * first N that fit (reserving room for a trailing `+N` counter) are shown
		 * and the rest are reported for the counter's tooltip.
		 * @param refs - the commit's ref decorations.
		 * @param budget - horizontal room for pills, in px.
		 * @returns `{ shown, extra, hidden }`.
		 */
		function planPills(refs, budget) {
			const list = Array.isArray(refs) ? refs.filter((ref) => ref !== null && ref !== undefined) : [];
			const room = Math.max(0, Number(budget) || 0);
			if (list.length === 0) return { shown: [], extra: 0, hidden: [] };
			let used = 0;
			let fit = 0;
			for (let index = 0; index < list.length; index += 1) {
				const gap = index === 0 ? 0 : PILL_GAP;
				const reserve = index + 1 < list.length ? PILL_COUNTER_WIDTH + PILL_GAP : 0;
				const next = used + gap + estimatePillWidth(list[index]?.name) + reserve;
				if (next > room) break;
				used += gap + estimatePillWidth(list[index]?.name);
				fit = index + 1;
			}
			if (fit >= list.length) return { shown: list.slice(), extra: 0, hidden: [] };
			return { shown: list.slice(0, fit), extra: list.length - fit, hidden: list.slice(fit) };
		}

		/** Unified diff of one file: hunks, two line-number gutters, add/del tints. */
		function DiffBlock({ state, translate }) {
			if (state === undefined || state === null || state.status === 'loading') {
				return h('div', { className: 'dshGitGraph_diffLoading' }, translate('detail.diffLoading'));
			}
			if (state.status === 'error') {
				return h(
					'div',
					{ className: 'dshGitGraph_fileBanner' },
					h('span', null, `${translate('detail.diffFailed')} (${state.error?.code ?? 'error'})`),
				);
			}
			const diff = state.value ?? {};
			const rows = [];
			if (diff.binary === true) {
				rows.push(h('div', { key: 'binary', className: 'dshGitGraph_diffNotice' }, translate('detail.binary')));
			} else if (!Array.isArray(diff.hunks) || diff.hunks.length === 0) {
				rows.push(h('div', { key: 'empty', className: 'dshGitGraph_diffNotice' }, translate('detail.noDiff')));
			} else {
				let lineBudget = 900;
				diff.hunks.forEach((hunk, hunkIndex) => {
					if (lineBudget <= 0) return;
					rows.push(h('div', { key: `hunk-${hunkIndex}`, className: 'dshGitGraph_diffHunk' }, hunk.header ?? ''));
					const lines = Array.isArray(hunk.lines) ? hunk.lines : [];
					for (let index = 0; index < lines.length && lineBudget > 0; index += 1) {
						const line = lines[index];
						const kind = line?.kind;
						const tone = kind === 'add' ? 'Add' : kind === 'del' ? 'Del' : '';
						rows.push(h(
							'div',
							{ key: `line-${hunkIndex}-${index}`, className: tone === '' ? 'dshGitGraph_diffRow' : `dshGitGraph_diffRow dshGitGraph_diffRow${tone}` },
							h('span', { key: 'old', className: 'dshGitGraph_diffNum' }, line?.oldLine === null || line?.oldLine === undefined ? '' : String(line.oldLine)),
							h('span', { key: 'new', className: 'dshGitGraph_diffNum' }, line?.newLine === null || line?.newLine === undefined ? '' : String(line.newLine)),
							h('span', { key: 'mark', className: 'dshGitGraph_diffMark' }, kind === 'add' ? '+' : kind === 'del' ? '-' : ' '),
							h('span', { key: 'text', className: 'dshGitGraph_diffText' }, typeof line?.text === 'string' && line.text !== '' ? line.text : ' '),
						));
						lineBudget -= 1;
					}
				});
			}
			if (diff.truncated === true) {
				rows.push(h('div', { key: 'truncated', className: 'dshGitGraph_diffNotice' }, translate('detail.truncated')));
			}
			return h('div', { className: 'dshGitGraph_diffBox' }, h('div', { className: 'dshGitGraph_diffInner' }, rows));
		}

		/** Right column: message, author, stats, changed files and expanded diffs. */
		function CommitDetail(props) {
			const { detail, translate, expanded, diffs, onToggleFile, onRetryDetail, drawer, onClose } = props;
			const close = drawer === true
				? h(
					'button',
					{
						type: 'button',
						className: 'dshGitGraph_iconBtn dshGitGraph_drawerClose',
						title: translate('toolbar.closeDetails'),
						'aria-label': translate('toolbar.closeDetails'),
						onClick: onClose,
					},
					icon('close', 14),
				)
				: null;
			let content;
			if (detail.value === null || detail.value === undefined) {
				if (detail.status === 'loading') {
					content = h(
						'div',
						{ key: 'loading', className: 'dshGitGraph_detailScroll' },
						h('div', { className: 'dshGitGraph_skBlock', style: { height: 16, width: '72%', marginBottom: 12 } }),
						h('div', { className: 'dshGitGraph_skBlock', style: { height: 11, width: '46%', marginBottom: 18 } }),
						[0, 1, 2, 3, 4].map((index) => h('div', {
							key: `line-${index}`,
							className: 'dshGitGraph_skBlock',
							style: { height: 11, width: `${92 - index * 11}%`, marginBottom: 9 },
						})),
					);
				} else if (detail.status === 'error') {
					content = h(
						'div',
						{ key: 'error', className: 'dshGitGraph_detailScroll' },
						h('div', { className: 'dshGitGraph_detailBanner' }, `${detail.error?.code ?? 'error'} · ${detail.error?.message ?? translate('detail.diffFailed')}`),
						h('button', { type: 'button', className: 'dshGitGraph_button', onClick: onRetryDetail }, translate('state.error.retry')),
					);
				} else {
					content = h(
						'div',
						{ key: 'empty', className: 'dshGitGraph_detailEmpty' },
						icon('commit', 26),
						h('div', { className: 'dshGitGraph_stateTitle', style: { fontSize: 12.5, fontWeight: 500 } }, translate('detail.empty')),
						h('div', null, translate('detail.emptyHint')),
					);
				}
			} else {
				const commit = detail.value;
				const author = commit.author ?? {};
				const committer = commit.committer ?? {};
				const files = Array.isArray(commit.files) ? commit.files : [];
				const stats = formatStats(commit.stats);
				const branchCount = countRefsOfKind(commit, 'branch') + countRefsOfKind(commit, 'remote');
				const committerDiffers = typeof committer.name === 'string' && committer.name !== author.name;
				const fileRows = files.map((file) => {
					const meta = statusMeta(file?.status);
					const path = typeof file?.path === 'string' ? file.path : '';
					const isOpen = expanded.has(path);
					const diffState = diffs[path];
					const additions = Number(file?.additions) || 0;
					const deletions = Number(file?.deletions) || 0;
					const split = splitFilePath(path);
					const displayPath = file?.oldPath ? translate('detail.rename', { oldPath: file.oldPath, newPath: path }) : path;
					return h(
						'div',
						{ key: path, className: 'dshGitGraph_fileWrap' },
						h(
							'button',
							{
								type: 'button',
								className: 'dshGitGraph_fileRow',
								'data-open': isOpen ? 'true' : 'false',
								'aria-expanded': isOpen,
								title: displayPath,
								'aria-label': translate('detail.fileAria', {
									path: displayPath,
									status: translate(meta.key),
									additions,
									deletions,
								}),
								onClick: () => onToggleFile(file),
							},
							h('span', { key: 'status', className: `dshGitGraph_fileStatus dshGitGraph_status${meta.tone}`, title: translate(meta.key) }, meta.letter),
							h(
								'span',
								{ key: 'path', className: 'dshGitGraph_filePath' },
								file?.oldPath
									? h('span', { className: 'dshGitGraph_fileDir' }, `${file.oldPath} → `)
									: null,
								file?.oldPath
									? h('span', { className: 'dshGitGraph_fileName' }, path)
									: h(React.Fragment, null,
										split.dir === '' ? null : h('span', { className: 'dshGitGraph_fileDir' }, split.dir),
										h('span', { className: 'dshGitGraph_fileName' }, split.base)),
							),
							h(
								'span',
								{ key: 'counts', className: 'dshGitGraph_fileCounts' },
								additions > 0 ? h('span', { key: 'a', className: 'dshGitGraph_add' }, `+${additions}`) : null,
								deletions > 0 ? h('span', { key: 'd', className: 'dshGitGraph_del' }, `−${deletions}`) : null,
							),
						),
						isOpen ? h(DiffBlock, { key: 'diff', state: diffState, translate }) : null,
					);
				});
				content = h(
					'div',
					{ key: 'ready', className: 'dshGitGraph_detailScroll' },
					h('h2', { className: 'dshGitGraph_detailSubject' }, typeof commit.subject === 'string' && commit.subject !== '' ? commit.subject : shortSha(commit.sha, 8)),
					h(
						'div',
						{ className: 'dshGitGraph_metaRow' },
						h('span', { key: 'sha', className: 'dshGitGraph_mono' }, shortSha(commit.sha, 8)),
						h('span', { key: 'sep1', className: 'dshGitGraph_metaSep' }, '·'),
						h(
							'span',
							{ key: 'avatar', className: 'dshGitGraph_avatar', title: typeof author.name === 'string' ? author.name : '' },
							isNumericName(author.name) ? icon('person', 11) : initialsOf(author.name),
						),
						h('span', { key: 'author', className: 'dshGitGraph_metaStrong' }, typeof author.name === 'string' ? author.name : ''),
						h('span', { key: 'sep2', className: 'dshGitGraph_metaSep' }, '·'),
						h('span', { key: 'date' }, formatDateTime(author.time)),
						branchCount >= 2
							? [
								h('span', { key: 'sep3', className: 'dshGitGraph_metaSep' }, '·'),
								h('span', { key: 'branches' }, translate('detail.branches', { count: branchCount })),
							]
							: null,
					),
					committerDiffers
						? h(
							'div',
							{ className: 'dshGitGraph_metaRow dshGitGraph_committerRow' },
							h('span', { className: 'dshGitGraph_metaSep' }, translate('detail.committer', { name: committer.name ?? '' })),
							h('span', { className: 'dshGitGraph_metaSep' }, '·'),
							h('span', null, formatDateTime(committer.time)),
						)
						: null,
					typeof commit.body === 'string' && commit.body.trim() !== ''
						? h('pre', { className: 'dshGitGraph_bodyText' }, commit.body)
						: null,
					h(
						'div',
						{ className: 'dshGitGraph_statsRow' },
						h('span', null, translate('detail.files', { count: files.length })),
						h('span', { className: 'dshGitGraph_metaSep' }, '·'),
						h('span', { className: 'dshGitGraph_add' }, `+${stats.additions}`),
						h('span', { className: 'dshGitGraph_del' }, `−${stats.deletions}`),
					),
					fileRows.length === 0
						? h('div', { className: 'dshGitGraph_refEmpty' }, translate('detail.noFiles'))
						: h('div', { className: 'dshGitGraph_fileList' }, fileRows),
				);
			}
			return h(
				'aside',
				{
					className: 'dshGitGraph_detail',
					'data-drawer': drawer === true ? 'true' : 'false',
					style: drawer === true ? undefined : { width: DETAIL_WIDTH },
					role: 'region',
					'aria-label': translate('toolbar.details'),
				},
				close,
				content,
			);
		}

		/** Centered icon/title/description panel used by every degraded state. */
		function StatePanel({ iconName, title, desc, path, actions, translate }) {
			return h(
				'div',
				{ className: 'dshGitGraph_statePanel' },
				h('div', { className: 'dshGitGraph_stateIcon' }, icon(iconName ?? 'git', 24)),
				h('div', { className: 'dshGitGraph_stateTitle' }, title),
				desc === undefined || desc === null || desc === '' ? null : h('div', { className: 'dshGitGraph_stateDesc' }, desc),
				path === undefined || path === null || path === '' ? null : h('div', { className: 'dshGitGraph_statePath', title: path }, path),
				Array.isArray(actions) && actions.length > 0
					? h('div', { className: 'dshGitGraph_stateActions' }, actions)
					: null,
			);
		}

		/**
		 * One repository row shared by the toolbar dropdown and the not-a-repo
		 * list: icon, name, a dimmed meta line and the current-repository check.
		 */
		function RepoOption(props) {
			const { name, meta, active, itemRole, ariaLabel, title, onClick } = props;
			return h(
				'button',
				{
					type: 'button',
					className: 'dshGitGraph_repoItem',
					role: itemRole,
					'data-active': active === true ? 'true' : 'false',
					'aria-current': active === true ? 'true' : 'false',
					title: typeof title === 'string' && title !== '' ? title : name,
					'aria-label': typeof ariaLabel === 'string' && ariaLabel !== '' ? ariaLabel : name,
					onClick,
				},
				icon('folder', 13),
				h(
					'span',
					{ className: 'dshGitGraph_repoItemMain' },
					h('span', { className: 'dshGitGraph_repoItemName' }, name),
					meta === undefined || meta === null || meta === '' ? null : h('span', { className: 'dshGitGraph_repoItemMeta' }, meta),
				),
				active === true ? icon('check', 12, 'dshGitGraph_repoItemCheck') : null,
			);
		}

		/** Meta line of one discovered repository: relative path · HEAD label. */
		function repoMetaText(repo, translate) {
			const head = describeRepoHead(repo?.head, translate);
			const rel = typeof repo?.rel === 'string' ? repo.rel : '';
			if (rel === '' || rel === head) return head;
			return head === '' ? rel : `${rel} · ${head}`;
		}

		/** Meta line of the session working directory row. */
		function sessionDirMeta(model, translate) {
			const parts = [];
			if (typeof model.cwd === 'string' && model.cwd !== '') parts.push(model.cwd);
			if (model.cwdRepo?.isRepo === true) {
				const head = describeRepoHead(model.cwdRepo.head, translate);
				const sha = typeof model.cwdRepo.head?.shortSha === 'string' ? model.cwdRepo.head.shortSha : '';
				const label = head === '' ? '' : sha !== '' && head !== sha ? `${head} @ ${sha}` : head;
				if (label !== '') parts.push(label);
			} else {
				parts.push(translate('repoMenu.notRepo'));
			}
			return parts.join(' · ');
		}

		/** Scan-limit hints shown under the repository list of the dropdown. */
		function repoLimitNotice(model, translate) {
			const scanned = model.scanned ?? {};
			const notices = [];
			if (scanned.depthLimitHit === true) notices.push(translate('repoMenu.depthLimit'));
			if (scanned.countLimitHit === true) notices.push(translate('repoMenu.countLimit'));
			if (scanned.dirLimitHit === true) notices.push(translate('repoMenu.dirLimit'));
			return notices.join(' · ');
		}

		/**
		 * Toolbar repository dropdown: the session working directory, every
		 * repository discovered below it, the native directory picker and a
		 * refresh action. All rows are real buttons, so Tab reaches them and
		 * Escape (handled by the view root) closes the menu.
		 */
		function RepoMenu(props) {
			const { model, translate, compact, onSelectRepo, onSelectSession, onPickDirectory, onRefresh } = props;
			const rows = [];
			rows.push(h('div', { key: 'title', className: 'dshGitGraph_repoMenuHead' }, translate('repoMenu.title')));
			const cwd = typeof model.cwd === 'string' ? model.cwd : '';
			rows.push(h(RepoOption, {
				key: 'session',
				name: translate('repoMenu.sessionDir'),
				meta: model.status === 'ready' ? sessionDirMeta({ cwd, cwdRepo: model.cwdRepo }, translate) : cwd,
				active: model.sessionActive === true,
				itemRole: 'menuitem',
				ariaLabel: `${translate('repoMenu.sessionDir')}${model.sessionActive === true ? ` · ${translate('repoMenu.current')}` : ''}`,
				title: cwd,
				onClick: onSelectSession,
			}));
			rows.push(h('div', { key: 'sep1', className: 'dshGitGraph_repoMenuSep', role: 'separator' }));
			rows.push(h(
				'div',
				{ key: 'section', className: 'dshGitGraph_repoMenuSection' },
				translate('repoMenu.discovered', { count: model.count }),
			));
			if (model.status === 'error') {
				rows.push(h(
					'div',
					{ key: 'scan-error', className: 'dshGitGraph_repoEmpty' },
					h('span', null, translate('repoMenu.error')),
					h(
						'button',
						{
							key: 'retry',
							type: 'button',
							role: 'menuitem',
							className: 'dshGitGraph_linkButton dshGitGraph_repoRetry',
							onClick: onRefresh,
						},
						translate('repoMenu.retry'),
					),
				));
			} else if (model.status !== 'ready' && model.count === 0) {
				rows.push(h('div', { key: 'scan-loading', className: 'dshGitGraph_repoEmpty' }, translate('repoMenu.loading')));
			} else if (model.count === 0) {
				rows.push(h('div', { key: 'scan-empty', className: 'dshGitGraph_repoEmpty' }, translate('repoMenu.empty')));
			} else {
				for (const repo of model.repos) {
					rows.push(h(RepoOption, {
						key: `repo-${repo.path}`,
						name: repo.name,
						meta: repoMetaText(repo, translate),
						active: repo.active === true,
						itemRole: 'menuitem',
						ariaLabel: translate('state.repoItemAria', { name: repo.name, rel: repo.rel }),
						title: repo.path,
						onClick: () => onSelectRepo(repo),
					}));
				}
			}
			const limits = repoLimitNotice(model, translate);
			if (limits !== '') rows.push(h('div', { key: 'limits', className: 'dshGitGraph_repoEmpty' }, limits));
			rows.push(h('div', { key: 'sep2', className: 'dshGitGraph_repoMenuSep', role: 'separator' }));
			rows.push(h(
				'div',
				{ key: 'foot', className: 'dshGitGraph_repoMenuFoot' },
				h(
					'button',
					{ key: 'pick', type: 'button', role: 'menuitem', className: 'dshGitGraph_button', onClick: onPickDirectory },
					icon('folder', 12),
					translate('repoMenu.pickDir'),
				),
				h(
					'button',
					{ key: 'refresh', type: 'button', role: 'menuitem', className: 'dshGitGraph_button', onClick: onRefresh },
					icon('refresh', 12),
					translate('repoMenu.refresh'),
				),
			));
			return h(
				'div',
				{
					id: 'dshGitGraph_repoMenu',
					className: 'dshGitGraph_repoMenu',
					role: 'menu',
					'aria-label': translate('repoMenu.aria'),
					'data-compact': compact === true ? 'true' : 'false',
				},
				rows,
			);
		}

		/**
		 * The not-a-repository state lists every discovered repository below its
		 * panel so one click opens that repository's history (SPEC §2).
		 */
		function RepoList(props) {
			const { model, translate, onSelectRepo, onRefresh } = props;
			const rows = [];
			if (model.status === 'error') {
				rows.push(h(
					'div',
					{ key: 'error', className: 'dshGitGraph_repoEmpty' },
					h('span', null, translate('state.repoListError')),
					h('button', { key: 'retry', type: 'button', className: 'dshGitGraph_linkButton', onClick: onRefresh }, translate('repoMenu.retry')),
				));
			} else if (model.status !== 'ready') {
				rows.push(h('div', { key: 'loading', className: 'dshGitGraph_repoEmpty' }, translate('state.repoListLoading')));
			} else if (model.count === 0) {
				rows.push(h('div', { key: 'empty', className: 'dshGitGraph_repoEmpty' }, translate('state.noRepos')));
			} else {
				for (const repo of model.repos) {
					rows.push(h(RepoOption, {
						key: `repo-${repo.path}`,
						name: repo.name,
						meta: repoMetaText(repo, translate),
						active: repo.active === true,
						itemRole: undefined,
						ariaLabel: translate('state.repoItemAria', { name: repo.name, rel: repo.rel }),
						title: repo.path,
						onClick: () => onSelectRepo(repo),
					}));
				}
			}
			return h(
				'div',
				{ className: 'dshGitGraph_stateRepos' },
				h('div', { className: 'dshGitGraph_stateReposTitle' }, translate('state.repoListTitle')),
				model.count > 0
					? h('div', { className: 'dshGitGraph_stateReposDesc' }, translate('state.repoListDesc'))
					: null,
				h(
					'div',
					{ className: 'dshGitGraph_repoList', role: 'group', 'aria-label': translate('state.repoListTitle') },
					rows,
				),
			);
		}

		/** First-paint skeleton with the three column shapes. */
		function SkeletonView({ refsWidth }) {
			const row = (key, width) => h('div', { key, className: 'dshGitGraph_skBlock', style: { height: 11, width } });
			const list = [];
			for (let index = 0; index < 18; index += 1) {
				list.push(h('div', {
					key: `r${index}`,
					className: 'dshGitGraph_skBlock',
					style: { height: 10, width: `${58 + ((index * 13) % 38)}%`, marginLeft: 22 },
				}));
			}
			return h(
				'div',
				{ className: 'dshGitGraph_skeleton' },
				h('div', { className: 'dshGitGraph_skCol', 'data-col': 'refs', style: { width: refsWidth } },
					row('r0', '52%'), row('r1', '70%'), row('r2', '62%'), row('r3', '78%'), row('r4', '55%')),
				h('div', { className: 'dshGitGraph_skCol', 'data-col': 'list' }, list),
				h('div', { className: 'dshGitGraph_skCol', 'data-col': 'detail', style: { width: DETAIL_WIDTH } },
					row('d0', '64%'), row('d1', '40%'), row('d2', '88%'), row('d3', '76%'), row('d4', '82%')),
			);
		}

		/* ------------------------------------------------------------------ */
		/* The view                                                            */
		/* ------------------------------------------------------------------ */

		/**
		 * Build the Conversation view component around the plugin context.
		 * The translator is bound at apply time (shipped views do the same), and
		 * an occupant-supplied `t` wins when the slot provides one.
		 * @param ctx - client plugin context (only optional services are read).
		 * @param boundT - translator bound to the `git-graph` namespace.
		 * @returns the React component registered as the `conversation.view` row.
		 */
		function createGitGraphView(ctx, boundT) {
			/** `head.shortSha` with a fallback for a partial repo value. */
			const shaOfHead = (head) => (typeof head?.sha === 'string' ? head.sha : '');

			return function GitGraphView(occupantProps) {
				const props = occupantProps ?? {};
				const translate = typeof props.t === 'function' ? props.t : boundT;
				const sessionId = typeof props.sessionId === 'string' ? props.sessionId : '';

				/* ---- view state ---- */
				const remembered = React.useMemo(() => recallSessionState(sessionId), [sessionId]);
				const [pickedCwd, setPickedCwd] = React.useState(() => (typeof remembered.pickedCwd === 'string' ? remembered.pickedCwd : null));
				const [query, setQuery] = React.useState(() => (typeof remembered.query === 'string' ? remembered.query : ''));
				const [refFilter, setRefFilter] = React.useState(() => (remembered.refFilter !== null && typeof remembered.refFilter === 'object' ? remembered.refFilter : null));
				const [repo, setRepo] = React.useState({ status: 'loading' });
				const [refs, setRefs] = React.useState({ status: 'loading' });
				const [log, setLog] = React.useState({ status: 'loading', commits: [], hasMore: false, headSha: null });
				const [selectedSha, setSelectedSha] = React.useState(() => (typeof remembered.sha === 'string' ? remembered.sha : null));
				const [detail, setDetail] = React.useState({ status: 'idle', sha: null, value: null, error: null });
				const [diffs, setDiffs] = React.useState({});
				const [expanded, setExpanded] = React.useState(() => new Set());
				const [refreshToken, setRefreshToken] = React.useState(0);
				const [loadingMore, setLoadingMore] = React.useState(false);
				const [pickError, setPickError] = React.useState(null);
				const [drawerOpen, setDrawerOpen] = React.useState(false);
				const [refsDrawerOpen, setRefsDrawerOpen] = React.useState(false);
				const [compact, setCompact] = React.useState(false);
				const [inlineMode, setInlineMode] = React.useState(false);
				const [availableHeight, setAvailableHeight] = React.useState(0);
				const [viewportHeight, setViewportHeight] = React.useState(0);
				const [scrollTop, setScrollTop] = React.useState(0);
				const [viewWidth, setViewWidth] = React.useState(0);
				const [reposState, setReposState] = React.useState({ status: 'idle', value: null, error: null });
				const [menuOpen, setMenuOpen] = React.useState(false);

				const api = React.useMemo(() => createGitApi(sessionId), [sessionId]);
				const rootRef = React.useRef(null);
				const listRef = React.useRef(null);
				const menuWrapRef = React.useRef(null);
				const loadingMoreRef = React.useRef(false);
				const diffInflightRef = React.useRef(new Set());
				/** Session id whose one-shot repository auto-selection already ran. */
				const autoSelectRef = React.useRef(remembered.repoAutoDone === true ? sessionId : '');
				/** Session of the last completed render; guards cross-session effect passes. */
				const previousSession = React.useRef(sessionId);

				/* ---- container measurement: fixed-height tool window + breakpoints ---- */
				React.useLayoutEffect(() => {
					const element = rootRef.current;
					if (element === null || typeof element.getBoundingClientRect !== 'function') return undefined;
					const measure = () => {
						const rect = element.getBoundingClientRect();
						let ancestorHeight = 0;
						let parent = element.parentElement;
						while (parent !== null && parent !== undefined) {
							const style = typeof getComputedStyle === 'function' ? getComputedStyle(parent) : null;
							const overflow = style === null ? '' : style.overflowY;
							if ((overflow === 'auto' || overflow === 'scroll') && parent.clientHeight > 0) {
								ancestorHeight = parent.clientHeight - Math.max(0, rect.top - parent.getBoundingClientRect().top);
								break;
							}
							parent = parent.parentElement;
						}
						const viewportHeight = typeof window !== 'undefined' && typeof window.innerHeight === 'number' ? window.innerHeight : 0;
						/* The page's message composer floats above the content: stop the
						 * tool window above it instead of running under it. */
						const composerTop = measureComposerTop(element, rect.top);
						const height = clampAvailableHeight({
							viewportHeight,
							rootTop: rect.top,
							ancestorHeight,
							composerTop,
						});
						if (height > 0) setAvailableHeight(height);
						if (rect.width > 0) {
							setViewWidth(Math.round(rect.width));
							setCompact(rect.width < COMPACT_WIDTH);
							setInlineMode(rect.width < INLINE_WIDTH);
						}
					};
					measure();
					let observer = null;
					if (typeof ResizeObserver === 'function') {
						observer = new ResizeObserver(measure);
						observer.observe(element);
						if (element.parentElement !== null) observer.observe(element.parentElement);
					}
					window.addEventListener('resize', measure);
					return () => {
						if (observer !== null) observer.disconnect();
						window.removeEventListener('resize', measure);
					};
				}, []);

				/* ---- repo + refs + first log page ---- */
				React.useEffect(() => {
					const controller = new AbortController();
					let active = true;
					const cwd = pickedCwd ?? undefined;
					if (sessionId === '' && pickedCwd === null) {
						setRepo({ status: 'error', error: { code: 'session-not-found', message: 'no session id' }, kind: 'session-missing' });
						return () => {
							active = false;
							controller.abort();
						};
					}
					setRepo((previous) => ({ status: 'loading', path: previous.path ?? pickedCwd ?? '', value: previous.value }));
					setPickError(null);
					(async () => {
						let repoValue;
						try {
							repoValue = await api.request('repo', { cwd }, controller.signal);
						} catch (error) {
							if (!active || error?.name === 'AbortError') return;
							const info = toDisplayError(error);
							if (info.code === 'not-a-repository') {
								setRepo({ status: 'not-repo', path: info.cwd ?? pickedCwd ?? '', error: info });
							} else if (info.code === 'git-not-found') {
								setRepo({ status: 'error', kind: 'git-not-found', path: pickedCwd ?? '', error: info });
							} else {
								setRepo({ status: 'error', path: pickedCwd ?? '', error: info });
							}
							return;
						}
						if (!active) return;
						const status = repoStatusOf(repoValue);
						const path = repoValue?.root ?? repoValue?.cwd ?? pickedCwd ?? '';
						if (status === 'error') {
							setRepo({ status: 'error', path, error: { code: 'bad-response', message: 'unexpected repository value' } });
							return;
						}
						if (status === 'not-repo') {
							setRepo({ status: 'not-repo', value: repoValue, path });
							setRefs({ status: 'ready', value: { head: null, branches: [], remotes: [], tags: [] } });
							setLog({ status: 'ready', commits: [], hasMore: false, headSha: null });
							return;
						}
						if (status === 'empty') {
							setRepo({ status: 'empty', value: repoValue, path });
							setRefs({ status: 'ready', value: { head: repoValue?.head ?? null, branches: [], remotes: [], tags: [] } });
							setLog({ status: 'ready', commits: [], hasMore: false, headSha: repoValue?.head?.sha ?? null });
							setSelectedSha(null);
							return;
						}
						setRepo({ status: 'ready', value: repoValue, path });
						const results = await Promise.allSettled([
							api.request('refs', { cwd }, controller.signal),
							api.request('log', { cwd, limit: PAGE_SIZE, ref: refFilterValue(refFilter) }, controller.signal),
						]);
						if (!active) return;
						const refsResult = results[0];
						const logResult = results[1];
						if (refsResult.status === 'fulfilled') setRefs({ status: 'ready', value: refsResult.value });
						else if (refsResult.reason?.name !== 'AbortError') setRefs({ status: 'error', error: toDisplayError(refsResult.reason) });
						if (logResult.status === 'fulfilled') {
							const value = logResult.value ?? {};
							const commits = Array.isArray(value.commits) ? value.commits : [];
							const headSha = value.headSha ?? repoValue?.head?.sha ?? null;
							setLog({ status: 'ready', commits, hasMore: value.hasMore === true, headSha });
							setSelectedSha((current) => (indexOfSha(commits, current) >= 0
								? current
								: pickDefaultSha(commits, headSha, remembered.sha)));
						} else if (logResult.reason?.name !== 'AbortError') {
							setLog({ status: 'error', commits: [], hasMore: false, headSha: null, error: toDisplayError(logResult.reason) });
						}
					})().catch(() => {});
					return () => {
						active = false;
						controller.abort();
					};
				}, [api, sessionId, pickedCwd, refFilter, refreshToken, remembered]);

				/* ---- repository discovery under the session working directory ---- */
				React.useEffect(() => {
					const controller = new AbortController();
					let active = true;
					if (sessionId === '') {
						setReposState({ status: 'idle', value: null, error: null });
						return () => {
							active = false;
							controller.abort();
						};
					}
					setReposState((previous) => ({ status: 'loading', value: previous.value ?? null, error: null }));
					api.request('repos', {}, controller.signal).then(
						(value) => {
							if (!active) return;
							setReposState({ status: 'ready', value: normalizeReposValue(value), error: null });
						},
						(error) => {
							if (!active || error?.name === 'AbortError') return;
							/* A missing session must stay quiet; the menu merely reports it. */
							setReposState({ status: 'error', value: null, error: toDisplayError(error) });
						},
					);
					return () => {
						active = false;
						controller.abort();
					};
				}, [api, sessionId, refreshToken]);

				/* ---- one-shot auto-selection of a lone repository (SPEC §2) ---- */
				React.useEffect(() => {
					/* The session-switch pass still carries the previous session's state. */
					if (previousSession.current !== sessionId) return;
					if (autoSelectRef.current === sessionId) return;
					const target = shouldAutoSelectSingleRepo({
						status: reposState.status,
						pickedCwd,
						cwdRepo: reposState.value?.cwdRepo,
						repos: reposState.value?.repos,
					});
					if (target === null) return;
					autoSelectRef.current = sessionId;
					setPickedCwd(target);
				}, [sessionId, reposState, pickedCwd]);

				/* An outside pointer press dismisses the repository dropdown. */
				React.useEffect(() => {
					if (!menuOpen) return undefined;
					if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined;
					const onPointerDown = (event) => {
						const wrap = menuWrapRef.current;
						if (wrap !== null && wrap !== undefined && typeof wrap.contains === 'function' && wrap.contains(event?.target)) return;
						setMenuOpen(false);
					};
					document.addEventListener('pointerdown', onPointerDown, true);
					return () => document.removeEventListener('pointerdown', onPointerDown, true);
				}, [menuOpen]);

				/* ---- list viewport height, for windowing ---- */
				React.useEffect(() => {
					const element = listRef.current;
					if (element === null || element === undefined || typeof element.clientHeight !== 'number') return undefined;
					const update = () => setViewportHeight(element.clientHeight);
					update();
					let observer = null;
					if (typeof ResizeObserver === 'function') {
						observer = new ResizeObserver(update);
						observer.observe(element);
					}
					window.addEventListener('resize', update);
					return () => {
						if (observer !== null) observer.disconnect();
						window.removeEventListener('resize', update);
					};
				}, [repo.status, inlineMode]);

				/* ---- commit detail, cached by sha ---- */
				React.useEffect(() => {
					if (repo.status !== 'ready' || typeof selectedSha !== 'string' || selectedSha === '') {
						setDetail({ status: 'idle', sha: null, value: null, error: null });
						return undefined;
					}
					const cached = commitCache.get(selectedSha);
					if (cached !== undefined) {
						setDetail({ status: 'ready', sha: selectedSha, value: cached });
						return undefined;
					}
					const controller = new AbortController();
					let active = true;
					setDetail({ status: 'loading', sha: selectedSha, value: null, error: null });
					api.request('commit', { cwd: pickedCwd ?? undefined, sha: selectedSha }, controller.signal).then(
						(value) => {
							if (!active) return;
							commitCache.set(selectedSha, value);
							setDetail({ status: 'ready', sha: selectedSha, value });
						},
						(error) => {
							if (!active || error?.name === 'AbortError') return;
							setDetail({ status: 'error', sha: selectedSha, value: null, error: toDisplayError(error) });
						},
					);
					return () => {
						active = false;
						controller.abort();
					};
				}, [api, repo.status, selectedSha, pickedCwd, refreshToken]);

				/* A new selection starts with every file collapsed. */
				React.useEffect(() => {
					setExpanded(new Set());
					setDiffs({});
				}, [selectedSha]);

				/* ---- file diffs of the expanded files ---- */
				React.useEffect(() => {
					if (repo.status !== 'ready' || detail.status !== 'ready' || detail.value === null) return undefined;
					const sha = detail.sha;
					const files = Array.isArray(detail.value.files) ? detail.value.files : [];
					const inflight = diffInflightRef.current;
					const controllers = [];
					let active = true;
					for (const path of expanded) {
						const key = diffPathKey(sha, path);
						const cached = diffCache.get(key);
						if (cached !== undefined) {
							setDiffs((previous) => (previous[path] === undefined ? { ...previous, [path]: { status: 'ready', value: cached } } : previous));
							continue;
						}
						if (inflight.has(path)) continue;
						const file = files.find((entry) => entry?.path === path);
						const controller = new AbortController();
						controllers.push(controller);
						inflight.add(path);
						setDiffs((previous) => ({ ...previous, [path]: { status: 'loading' } }));
						api.request('diff', {
							cwd: pickedCwd ?? undefined,
							sha,
							path,
							oldPath: file?.oldPath ?? undefined,
						}, controller.signal).then(
							(value) => {
								inflight.delete(path);
								if (!active) return;
								diffCache.set(key, value);
								setDiffs((previous) => ({ ...previous, [path]: { status: 'ready', value } }));
							},
							(error) => {
								inflight.delete(path);
								if (!active || error?.name === 'AbortError') return;
								setDiffs((previous) => ({ ...previous, [path]: { status: 'error', error: toDisplayError(error) } }));
							},
						);
					}
					return () => {
						active = false;
						for (const controller of controllers) controller.abort();
					};
				}, [api, repo.status, detail.status, detail.sha, detail.value, expanded, pickedCwd, refreshToken]);

				/* ---- session memory and session switches ---- */
				React.useEffect(() => {
					/* Do not write the previous session's state under the new session. */
					if (previousSession.current !== sessionId) return;
					rememberSessionState(sessionId, {
						sha: selectedSha,
						refFilter,
						query,
						pickedCwd,
						/* Keep the one-shot auto-selection from running twice per session. */
						repoAutoDone: autoSelectRef.current === sessionId,
					});
				}, [sessionId, selectedSha, refFilter, query, pickedCwd, refreshToken]);

				React.useEffect(() => {
					if (previousSession.current === sessionId) return;
					previousSession.current = sessionId;
					const next = recallSessionState(sessionId);
					setPickedCwd(typeof next.pickedCwd === 'string' ? next.pickedCwd : null);
					setQuery(typeof next.query === 'string' ? next.query : '');
					setRefFilter(next.refFilter !== null && typeof next.refFilter === 'object' ? next.refFilter : null);
					setSelectedSha(typeof next.sha === 'string' ? next.sha : null);
					setMenuOpen(false);
					autoSelectRef.current = next.repoAutoDone === true ? sessionId : '';
				}, [sessionId]);

				/* Scroll resets when the visible list definition changes. */
				React.useEffect(() => {
					setScrollTop(0);
					const element = listRef.current;
					if (element !== null && element !== undefined && typeof element.scrollTop === 'number') element.scrollTop = 0;
				}, [log.status, refFilter, query]);

				/* ---- derived rows ---- */
				const filtered = React.useMemo(() => filterCommits(log.commits, query), [log.commits, query]);
				const laneLayout = React.useMemo(() => assignLanes(filtered), [filtered]);
				const graphGutter = graphWidth(laneLayout.laneCount);
				const template = columnTemplate(graphGutter, compact);
				/* Pill budget: what a row can spare beside the subject, before the
				 * counter reserve; keeps every rendered pill whole at any width. */
				const refsColumnWidth = inlineMode ? 0 : compact ? 168 : 224;
				const measuredWidth = viewWidth > 0 ? viewWidth : 1280;
				const listColumnWidth = Math.max(
					280,
					measuredWidth - refsColumnWidth - (compact ? 0 : DETAIL_WIDTH) - 2,
				);
				const columnsWidth = compact ? 72 + 78 + 56 : AUTHOR_WIDTH + DATE_WIDTH + SHA_WIDTH;
				const pillsBudget = Math.max(
					0,
					Math.min(PILL_BUDGET_CAP, (listColumnWidth - graphGutter - columnsWidth - 24) * 0.44),
				);
				const windowInfo = React.useMemo(
					() => computeWindow(scrollTop, viewportHeight, ROW_HEIGHT, filtered.length, OVERSCAN),
					[scrollTop, viewportHeight, filtered.length],
				);
				const laneRows = laneLayout.rows;
				const refsTree = React.useMemo(() => buildRefsTree(refs.value), [refs.value]);
				const repoMenu = React.useMemo(() => buildRepoMenu(reposState, pickedCwd), [reposState, pickedCwd]);
				const headSha = log.headSha ?? repo.value?.head?.sha ?? null;

				/* ---- interaction callbacks ---- */
				const selectCommit = React.useCallback((sha) => {
					if (typeof sha !== 'string' || sha === '') return;
					setSelectedSha(sha);
					setDrawerOpen(true);
				}, []);

				const scrollRowIntoView = React.useCallback((index) => {
					const element = listRef.current;
					if (element === null || element === undefined || typeof element.scrollTop !== 'number') return;
					const top = index * ROW_HEIGHT;
					const bottom = top + ROW_HEIGHT;
					if (top < element.scrollTop) element.scrollTop = top;
					else if (bottom > element.scrollTop + element.clientHeight) element.scrollTop = bottom - element.clientHeight;
				}, []);

				const onListKeyDown = React.useCallback((event) => {
					if (event === null || event === undefined) return;
					const key = event.key;
					if (key !== 'ArrowDown' && key !== 'ArrowUp' && key !== 'Home' && key !== 'End' && key !== 'PageDown' && key !== 'PageUp') return;
					if (filtered.length === 0) return;
					const current = indexOfSha(filtered, selectedSha);
					const base = current < 0 ? -1 : current;
					let next = base;
					if (key === 'ArrowDown') next = Math.min(filtered.length - 1, base + 1);
					else if (key === 'ArrowUp') next = base <= 0 ? 0 : base - 1;
					else if (key === 'Home') next = 0;
					else if (key === 'End') next = filtered.length - 1;
					else if (key === 'PageDown') next = Math.min(filtered.length - 1, Math.max(0, base) + 12);
					else if (key === 'PageUp') next = Math.max(0, Math.max(0, base) - 12);
					if (next < 0 || next === current) return;
					if (typeof event.preventDefault === 'function') event.preventDefault();
					const commit = filtered[next];
					selectCommit(commit?.sha);
					scrollRowIntoView(next);
				}, [filtered, selectedSha, selectCommit, scrollRowIntoView]);

				const loadMore = React.useCallback(() => {
					if (log.status !== 'ready' || log.hasMore !== true || loadingMoreRef.current) return;
					loadingMoreRef.current = true;
					setLoadingMore(true);
					const controller = new AbortController();
					api.request('log', {
						cwd: pickedCwd ?? undefined,
						limit: PAGE_SIZE,
						skip: log.commits.length,
						ref: refFilterValue(refFilter),
					}, controller.signal).then(
						(value) => {
							const page = Array.isArray(value?.commits) ? value.commits : [];
							setLog((previous) => ({
								...previous,
								commits: mergeCommitPages(previous.commits, page),
								hasMore: value?.hasMore === true && page.length > 0,
							}));
						},
						() => {},
					).finally(() => {
						loadingMoreRef.current = false;
						setLoadingMore(false);
					});
				}, [api, log.status, log.hasMore, log.commits.length, pickedCwd, refFilter]);
				const loadMoreRef = React.useRef(loadMore);
				loadMoreRef.current = loadMore;

				const onListScroll = React.useCallback((event) => {
					const target = event?.currentTarget;
					if (target === null || target === undefined) return;
					setScrollTop(target.scrollTop);
					if (shouldRequestMore(target.scrollTop, target.clientHeight, target.scrollHeight)) loadMoreRef.current();
				}, []);

				const onRootKeyDown = React.useCallback((event) => {
					if (event?.key !== 'Escape') return;
					if (menuOpen) {
						setMenuOpen(false);
						return;
					}
					if (drawerOpen && compact) setDrawerOpen(false);
					if (refsDrawerOpen) setRefsDrawerOpen(false);
					if (query !== '') setQuery('');
				}, [menuOpen, drawerOpen, compact, refsDrawerOpen, query]);

				const chooseRepository = React.useCallback(async () => {
					setPickError(null);
					let picker = null;
					try {
						if (ctx !== null && ctx !== undefined && typeof ctx.get === 'function') picker = ctx.get('uiWorkspace');
					} catch (error) {
						picker = null;
					}
					if (picker === null || picker === undefined || typeof picker.pickDirectory !== 'function') {
						setPickError(translate('state.pickFailed', { message: 'uiWorkspace.pickDirectory is unavailable' }));
						return;
					}
					try {
						const picked = await picker.pickDirectory();
						if (typeof picked !== 'string' || picked === '') return;
						setPickedCwd(picked);
						/* A ref filter names a ref of the previous repository. */
						setRefFilter(null);
						setRefreshToken((token) => token + 1);
					} catch (error) {
						const message = error !== null && typeof error === 'object' && typeof error.message === 'string' ? error.message : String(error);
						setPickError(translate('state.pickFailed', { message }));
					}
				}, [ctx, translate]);

				/** Switch to a discovered repository and reload every column for it. */
				const selectRepository = React.useCallback((path) => {
					setMenuOpen(false);
					if (typeof path !== 'string' || path === '') return;
					setPickedCwd(path);
					/* The ref filter (and the selected commit) belong to the old repository. */
					setRefFilter(null);
					setSelectedSha(null);
					setRefreshToken((token) => token + 1);
				}, []);

				const useSessionDirectory = React.useCallback(() => {
					/* An explicit choice of the session directory settles auto-selection. */
					autoSelectRef.current = sessionId;
					setMenuOpen(false);
					setPickedCwd(null);
					/* Back to the session directory: the sub-repository filter cannot apply. */
					setRefFilter(null);
					setRefreshToken((token) => token + 1);
				}, [sessionId]);

				const retry = React.useCallback(() => setRefreshToken((token) => token + 1), []);
				const toggleMenu = React.useCallback(() => setMenuOpen((open) => !open), []);

				const selectRef = React.useCallback((item) => {
					if (item === null || item === undefined) {
						setRefFilter(null);
						return;
					}
					setRefFilter({ key: item.key, kind: item.kind, name: item.name, ref: item.ref });
					if (inlineMode) setRefsDrawerOpen(false);
				}, [inlineMode]);

				const onSelectAll = React.useCallback(() => selectRef(null), [selectRef]);

				const toggleFile = React.useCallback((file) => {
					const path = typeof file?.path === 'string' ? file.path : '';
					if (path === '') return;
					setExpanded((previous) => {
						const next = new Set(previous);
						if (next.has(path)) next.delete(path);
						else next.add(path);
						return next;
					});
				}, []);

				/* ---- toolbar ---- */
				const repoPath = repo.path ?? pickedCwd ?? '';
				const head = repo.value?.head ?? null;
				const headLabel = head === null || head === undefined
					? ''
					: head.type === 'branch' && typeof head.name === 'string'
						? head.name
						: head.type === 'detached'
							? 'HEAD (detached)'
							: typeof head.name === 'string' ? head.name : '';
				const headShort = typeof head?.shortSha === 'string' && head.shortSha !== '' ? head.shortSha : shortSha(shaOfHead(head));
				const dirty = Number(repo.value?.dirtyFiles) || 0;
				const ahead = Number(repo.value?.ahead) || 0;
				const behind = Number(repo.value?.behind) || 0;
				const spinning = repo.status === 'loading' || log.status === 'loading' || reposState.status === 'loading';
				const showDetailColumn = !compact || drawerOpen;
				const refsWidth = refsColumnWidth;

				const toolbar = h(
					'div',
					{ className: 'dshGitGraph_toolbar' },
					h(
						'div',
						{ className: 'dshGitGraph_repoWrap', ref: menuWrapRef },
						h(
							'button',
							{
								type: 'button',
								className: 'dshGitGraph_repo dshGitGraph_repoTrigger',
								title: repoPath === ''
									? translate('toolbar.chooseRepo')
									: repo.status === 'loading'
										? translate('state.switching', { path: repoPath })
										: repoPath,
								'aria-label': translate('toolbar.repoAria', { path: repoPath === '' ? translate('toolbar.chooseRepo') : repoPath }),
								'aria-haspopup': 'menu',
								'aria-expanded': menuOpen,
								'aria-controls': menuOpen ? 'dshGitGraph_repoMenu' : undefined,
								onClick: toggleMenu,
							},
							icon('folder', 13),
							h('span', { className: 'dshGitGraph_repoPath' }, repoPath === '' ? translate('toolbar.chooseRepo') : shortPath(repoPath, PATH_MAX)),
							icon('chevronDown', 10, 'dshGitGraph_repoCaret'),
						),
						menuOpen
							? h(RepoMenu, {
								key: 'menu',
								model: repoMenu,
								translate,
								compact,
								onSelectRepo: (repo) => selectRepository(repo?.path),
								onSelectSession: useSessionDirectory,
								onPickDirectory: () => {
									setMenuOpen(false);
									chooseRepository();
								},
								onRefresh: retry,
							})
							: null,
					),
					pickedCwd === null
						? null
						: h(
							'button',
							{
								type: 'button',
								className: 'dshGitGraph_iconBtn',
								style: { width: 20, height: 20 },
								title: translate('toolbar.useSessionDir'),
								'aria-label': translate('toolbar.useSessionDir'),
								onClick: useSessionDirectory,
							},
							icon('close', 11),
						),
					headLabel === ''
						? null
						: h(
							'span',
							{ className: 'dshGitGraph_tools' },
							h(
								'span',
								{ className: 'dshGitGraph_headChip', title: headLabel },
								icon('branch', 12),
								h('b', null, headLabel),
								headShort === '' ? null : h('span', { className: 'dshGitGraph_headSha' }, headShort),
							),
						),
					dirty > 0
						? h(
							'span',
							{ className: 'dshGitGraph_metaChip dshGitGraph_metaDirty', title: translate('toolbar.dirty', { count: dirty }) },
							icon('dot', 11),
							h('span', null, String(dirty)),
						)
						: null,
					ahead > 0
						? h('span', { className: 'dshGitGraph_metaChip dshGitGraph_metaAhead', title: translate('toolbar.ahead', { count: ahead }) }, icon('arrowUp', 11), h('span', null, String(ahead)))
						: null,
					behind > 0
						? h('span', { className: 'dshGitGraph_metaChip dshGitGraph_metaBehind', title: translate('toolbar.behind', { count: behind }) }, icon('arrowDown', 11), h('span', null, String(behind)))
						: null,
					pickError === null
						? null
						: h(
							'span',
							{ className: 'dshGitGraph_metaChip dshGitGraph_metaBehind', title: pickError },
							icon('alert', 11),
							h('span', null, translate('state.pickFailedShort')),
						),
					refFilter === null
						? null
						: h(
							'button',
							{
								type: 'button',
								className: 'dshGitGraph_filterChip',
								title: translate('toolbar.clearFilter'),
								'aria-label': translate('toolbar.clearFilter'),
								onClick: onSelectAll,
							},
							icon(refFilter.kind === 'tag' ? 'tag' : refFilter.kind === 'remote' ? 'remote' : 'branch', 11),
							h('span', null, translate('toolbar.filteredBy', { name: refFilter.name ?? '' })),
							icon('close', 10),
						),
					h('span', { className: 'dshGitGraph_spacer' }),
					inlineMode
						? h(
							'button',
							{
								type: 'button',
								className: 'dshGitGraph_iconBtn',
								'aria-expanded': refsDrawerOpen,
								title: translate('toolbar.refsPanel'),
								'aria-label': translate('toolbar.refsPanel'),
								onClick: () => setRefsDrawerOpen((open) => !open),
							},
							icon('branch', 14),
						)
						: null,
					h(
						'div',
						{ className: 'dshGitGraph_search' },
						icon('search', 12),
						h('input', {
							className: 'dshGitGraph_searchInput',
							type: 'search',
							value: query,
							placeholder: translate('toolbar.searchPlaceholder'),
							'aria-label': translate('toolbar.searchAria'),
							onChange: (event) => setQuery(typeof event?.target?.value === 'string' ? event.target.value : ''),
							onKeyDown: (event) => {
								if (event?.key !== 'Escape') return;
								setQuery('');
								if (typeof event.stopPropagation === 'function') event.stopPropagation();
							},
						}),
					),
					h(
						'button',
						{
							type: 'button',
							className: 'dshGitGraph_iconBtn',
							'data-spinning': spinning ? 'true' : 'false',
							title: translate('toolbar.refresh'),
							'aria-label': translate('toolbar.refresh'),
							onClick: retry,
						},
						icon('refresh', 14),
					),
					compact
						? h(
							'button',
							{
								type: 'button',
								className: 'dshGitGraph_iconBtn',
								'aria-expanded': drawerOpen,
								title: translate('toolbar.details'),
								'aria-label': translate('toolbar.details'),
								onClick: () => setDrawerOpen((open) => !open),
							},
							icon('commit', 14),
						)
						: null,
				);

				/* ---- first-paint and degraded states ---- */
				let content = null;
				if (repo.status === 'loading' && repo.value === undefined) {
					content = h(SkeletonView, { refsWidth });
				} else if (repo.status === 'error' || repo.status === 'not-repo' || repo.status === 'empty') {
					const error = repo.error ?? {};
					const isNotRepo = repo.status === 'not-repo';
					const isMissingSession = repo.kind === 'session-missing';
					const isNoGit = repo.kind === 'git-not-found';
					let title;
					let desc;
					let path = null;
					let iconName = 'git';
					if (isNotRepo) {
						title = pickedCwd === null ? translate('state.notRepo.title') : translate('state.pickedNotRepo.title');
						desc = pickedCwd === null ? translate('state.notRepo.desc') : translate('state.pickedNotRepo.desc');
						path = repo.path ?? '';
						iconName = 'folder';
					} else if (repo.status === 'empty') {
						title = translate('state.empty.title');
						desc = translate('state.empty.desc');
						path = repo.path ?? '';
						iconName = 'commit';
					} else if (isNoGit) {
						title = translate('state.noGit.title');
						desc = translate('state.noGit.desc');
						iconName = 'alert';
					} else if (isMissingSession) {
						title = translate('state.sessionMissing.title');
						desc = translate('state.sessionMissing.desc');
						iconName = 'git';
					} else {
						title = translate('state.error.title');
						desc = `${error.code ?? 'error'}${typeof error.message === 'string' && error.message !== '' ? ` · ${error.message}` : ''}`;
						path = repo.path ?? '';
						iconName = 'alert';
					}
					const actions = [
						h('button', { key: 'retry', type: 'button', className: 'dshGitGraph_button', onClick: retry }, icon('refresh', 13), translate('state.error.retry')),
						h('button', { key: 'choose', type: 'button', className: 'dshGitGraph_button', onClick: chooseRepository }, icon('folder', 13), translate('state.chooseRepo')),
					];
					if (pickedCwd !== null) {
						actions.push(h('button', { key: 'session', type: 'button', className: 'dshGitGraph_button', onClick: useSessionDirectory }, translate('state.backToSession')));
					}
					content = h(
						'div',
						{ className: 'dshGitGraph_body', 'data-degraded': 'true' },
						h(
							'div',
							{ className: 'dshGitGraph_degradedInner' },
							h(StatePanel, { iconName, title, desc, path, actions, translate }),
							repo.status === 'not-repo'
								? h(RepoList, {
									key: 'repos',
									model: repoMenu,
									translate,
									onSelectRepo: (repo) => selectRepository(repo?.path),
									onRefresh: retry,
								})
								: null,
							pickError === null
								? null
								: h('div', { key: 'pick-error', className: 'dshGitGraph_stateCode' }, pickError),
							repo.status === 'empty'
								? h('div', { key: 'empty-hint', className: 'dshGitGraph_stateCode' }, translate('state.empty.hint'))
								: null,
							repo.status === 'error' && error.code !== undefined && !isNoGit
								? h('div', { key: 'error-code', className: 'dshGitGraph_stateCode' }, translate('state.error.code', { code: error.code ?? 'error' }))
								: null,
						),
					);
				} else {
					/* ---- three columns ---- */
					const noResults = filtered.length === 0 && (query !== '' || refFilter !== null);
					const listRows = [];
					if (windowInfo.topPad > 0) listRows.push(h('div', { key: 'pad-top', style: { height: windowInfo.topPad }, 'aria-hidden': true }));
					if (noResults) {
						listRows.push(h(
							'div',
							{ key: 'no-results', className: 'dshGitGraph_noResults' },
							icon(query !== '' ? 'search' : 'commit', 22),
							h('div', null, query !== '' ? translate('list.noResults') : translate('list.emptyRef')),
							query !== '' ? h('div', null, translate('list.noResultsHint')) : null,
							h(
								'button',
								{
									type: 'button',
									className: 'dshGitGraph_linkButton',
									onClick: () => {
										setQuery('');
										setRefFilter(null);
									},
								},
								query !== '' ? translate('list.clearSearch') : translate('list.byRefClear'),
							),
						));
					} else {
						const end = windowInfo.virtual ? windowInfo.end : filtered.length;
						const start = windowInfo.virtual ? windowInfo.start : 0;
						for (let index = start; index < end; index += 1) {
							const commit = filtered[index];
							const lane = laneRows[index];
							const sha = typeof commit?.sha === 'string' ? commit.sha : `row-${index}`;
							const isSelected = sha === selectedSha;
							listRows.push(h(
								'div',
								{
									key: sha,
									id: `dshGitGraph_row_${sha}`,
									className: 'dshGitGraph_row',
									role: 'option',
									'aria-selected': isSelected,
									style: { gridTemplateColumns: template },
									title: typeof commit?.subject === 'string' ? commit.subject : '',
									onClick: () => {
										selectCommit(sha);
										/* Keep arrow-key navigation live right after a pointer selection. */
										const listElement = listRef.current;
										if (listElement !== null && listElement !== undefined && typeof listElement.focus === 'function') listElement.focus();
									},
								},
								h('div', { key: 'graph', className: 'dshGitGraph_graphCell' }, lane === undefined
									? null
									: h(GraphCell, { row: lane, isHead: sha === headSha, laneCount: laneLayout.laneCount })),
								h(
									'div',
									{ key: 'subject', className: 'dshGitGraph_subjectCell' },
									h('span', { className: 'dshGitGraph_subjectText' }, typeof commit?.subject === 'string' ? commit.subject : ''),
									h(RefPills, { refs: commit?.refs, budget: pillsBudget }),
								),
								h('span', { key: 'author', className: 'dshGitGraph_authorCell' }, typeof commit?.author?.name === 'string' ? commit.author.name : ''),
								h('span', { key: 'date', className: 'dshGitGraph_dateCell' }, formatTime(commit?.author?.time, undefined, translate)),
								h('span', { key: 'sha', className: 'dshGitGraph_shaCell' }, shortSha(sha)),
							));
						}
					}
					if (windowInfo.bottomPad > 0) listRows.push(h('div', { key: 'pad-bottom', style: { height: windowInfo.bottomPad }, 'aria-hidden': true }));
					const bodyColumns = [
						!inlineMode
							? h(RefsTree, {
								key: 'refs',
								tree: refsTree,
								filter: refFilter,
								onSelect: selectRef,
								translate,
								drawer: false,
								style: { width: refsWidth },
							})
							: null,
						h(
							'section',
							{ key: 'list', className: 'dshGitGraph_listCol' },
							h(
								'div',
								{ className: 'dshGitGraph_listHead', style: { gridTemplateColumns: template } },
								h('span', { key: 'g', className: 'dshGitGraph_listHeadCell' }),
								h('span', { key: 'd', className: 'dshGitGraph_listHeadCell' }, translate('col.description')),
								h('span', { key: 'a', className: 'dshGitGraph_listHeadCell' }, translate('col.author')),
								h('span', { key: 't', className: 'dshGitGraph_listHeadCell', 'data-align': 'end' }, translate('col.date')),
								h('span', { key: 's', className: 'dshGitGraph_listHeadCell', 'data-align': 'end' }, translate('col.commit')),
							),
							log.status === 'error'
								? h(
									'div',
									{ className: 'dshGitGraph_listScroll' },
									h(StatePanel, {
										iconName: 'alert',
										title: translate('state.error.title'),
										desc: `${log.error?.code ?? 'error'}${typeof log.error?.message === 'string' && log.error.message !== '' ? ` · ${log.error.message}` : ''}`,
										translate,
										actions: [h('button', { key: 'retry', type: 'button', className: 'dshGitGraph_button', onClick: retry }, translate('state.error.retry'))],
									}),
								)
								: h(
									'div',
									{
										key: 'scroll',
										ref: listRef,
										className: 'dshGitGraph_listScroll',
										role: 'listbox',
										tabIndex: 0,
										'aria-label': translate('a11y.list'),
										'aria-activedescendant': selectedSha === null ? undefined : `dshGitGraph_row_${selectedSha}`,
										onKeyDown: onListKeyDown,
										onScroll: onListScroll,
									},
									listRows,
								),
							h(
								'div',
								{ className: 'dshGitGraph_listFoot' },
								h(
									'span',
									{ className: 'dshGitGraph_listFootLeft' },
									h('span', null, log.status === 'loading'
										? translate('state.loading')
										: query !== '' || refFilter !== null
											? translate('list.showingCount', { shown: filtered.length, total: log.commits.length })
											: translate('list.allLoaded', { count: log.commits.length })),
									log.commits.length > 0 ? h('span', null, translate('list.keyboardHint')) : null,
								),
								loadingMore
									? h('span', null, translate('list.loadMore'))
									: log.hasMore === true
										? h('button', { type: 'button', className: 'dshGitGraph_linkButton', onClick: loadMore }, translate('list.loadMore'))
										: null,
							),
						),
						showDetailColumn
							? h(CommitDetail, {
								key: 'detail',
								detail,
								translate,
								expanded,
								diffs,
								onToggleFile: toggleFile,
								onRetryDetail: retry,
								drawer: compact,
								onClose: () => setDrawerOpen(false),
							})
							: null,
						inlineMode && refsDrawerOpen
							? h(RefsTree, {
								key: 'refs-drawer',
								tree: refsTree,
								filter: refFilter,
								onSelect: selectRef,
								translate,
								drawer: true,
								onClose: () => setRefsDrawerOpen(false),
							})
							: null,
					];
					content = h('div', { key: 'body', className: 'dshGitGraph_body' }, bodyColumns);
				}

				const rootStyle = availableHeight > 0 ? { height: `${availableHeight}px` } : undefined;
				return h(
					'div',
					{
						ref: rootRef,
						className: 'dshGitGraph_root',
						style: rootStyle,
						role: 'tabpanel',
						'aria-label': translate('a11y.view'),
						onKeyDown: onRootKeyDown,
					},
					toolbar,
					content,
				);
			};
		}

		/* ------------------------------------------------------------------ */
		/* Test hook and plugin registration                                   */
		/* ------------------------------------------------------------------ */

		/**
		 * Pure surface for `test-client/`. Only installed when the page sets the
		 * flag before this bundle is evaluated, so a real page never sees it.
		 */
		const internals = {
			LANE_COLORS,
			LANE_WIDTH,
			LANE_PAD,
			ROW_HEIGHT,
			MAX_GRAPH_LANES,
			laneVars,
			CSS,
			assignLanes,
			graphSegmentPath,
			graphWidth,
			MIN_VIEW_HEIGHT,
			COMPOSER_GAP,
			COMPOSER_INSET,
			composerTopFromRects,
			clampAvailableHeight,
			measureComposerTop,
			columnTemplate,
			shortSha,
			shortPath,
			formatDateTime,
			formatTime,
			statusMeta,
			filterCommits,
			refFilterValue,
			buildRefsTree,
			indexOfSha,
			pickDefaultSha,
			nextSelectedIndex,
			mergeCommitPages,
			shouldRequestMore,
			computeWindow,
			formatStats,
			countRefsOfKind,
			diffPathKey,
			splitFilePath,
			createLru,
			GitGraphError,
			parseEnvelope,
			toDisplayError,
			repoStatusOf,
			normalizePathValue,
			samePath,
			lastPathSegment,
			normalizeCwdRepo,
			normalizeRepoEntry,
			normalizeReposValue,
			buildRepoMenu,
			describeRepoHead,
			shouldAutoSelectSingleRepo,
			rememberSessionState,
			recallSessionState,
			sessionMemory,
			commitCache,
			diffCache,
			createGitApi,
			initialsOf,
			isNumericName,
			hasCjkName,
			planPills,
			estimatePillWidth,
		};

		try {
			if (typeof window !== 'undefined' && window.__DSH_GIT_GRAPH_TEST__ === true) {
				window.__DSH_GIT_GRAPH_INTERNALS__ = internals;
			}
		} catch (error) {
			/* The test hook must never break the page. */
		}

		return {
			inject: ['slots', 'locale'],
			apply(ctx) {
				ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'git-graph: dictionaries');
				ctx.effect(() => {
					const tag = document.createElement('style');
					tag.dataset.plugin = '@local/dsh-git-graph';
					tag.dataset.pluginCss = NS;
					tag.textContent = CSS;
					document.head.appendChild(tag);
					return () => {
						tag.remove();
					};
				}, 'git-graph: stylesheet');
				const bound = typeof ctx.locale.bind === 'function' ? ctx.locale.bind(NS) : fallbackTranslate;
				const View = createGitGraphView(ctx, bound);
				ctx.slots.inject('conversation.view', () => ctx.slots.register({
					name: 'conversation.view',
					id: 'git-graph',
					order: 200,
					label: () => bound('view.label'),
					locale: NS,
				}, View));
			},
		};
	},
});
