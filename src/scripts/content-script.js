let site; // the site that the content-script was loaded on (lichess, chess.com, blitztactics.com)
let config; // configuration pulled from popup
let startPosCache; // cache of non-standard starting positions as puzzle strings (to support chess960)
let moving = false; // whether the content-script is performing a move

const LOCAL_CACHE = 'mephisto.startPosCache';
const DEFAULT_POSITION = 'w*****b-r-a8*****b-n-b8*****b-b-c8*****b-q-d8*****b-k-e8*****b-b-f8*****b-n-g8*****' +
    'b-r-h8*****b-p-a7*****b-p-b7*****b-p-c7*****b-p-d7*****b-p-e7*****b-p-f7*****b-p-g7*****b-p-h7*****' +
    'w-p-a2*****w-p-b2*****w-p-c2*****w-p-d2*****w-p-e2*****w-p-f2*****w-p-g2*****w-p-h2*****w-r-a1*****' +
    'w-n-b1*****w-b-c1*****w-q-d1*****w-k-e1*****w-b-f1*****w-n-g1*****w-r-h1*****';

// Global error handlers for content-script to help surface errors and persist them
(function () {
    function storeRecord(rec) {
        try {
            if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
                chrome.storage.local.get(['mephisto_error_logs'], (res) => {
                    const arr = (res && res.mephisto_error_logs) ? res.mephisto_error_logs : [];
                    arr.push(rec);
                    try { chrome.storage.local.set({ mephisto_error_logs: arr }); } catch (e) { }
                });
            } else if (window && window.localStorage) {
                const key = 'mephisto_error_logs';
                const arr = JSON.parse(localStorage.getItem(key) || '[]');
                arr.push(rec);
                localStorage.setItem(key, JSON.stringify(arr));
            }
        } catch (e) {
            console.error('content-script error storage failed', e);
        }
    }

    window.onerror = function (message, source, lineno, colno, error) {
        const rec = {
            ts: Date.now(),
            context: 'content-script',
            type: 'error',
            message: message && message.toString ? message.toString() : String(message),
            source: source || null,
            lineno: lineno || null,
            colno: colno || null,
            stack: error && error.stack ? error.stack : null
        };
        console.error('[Mephisto][content-script]', rec);
        storeRecord(rec);
        return false;
    };

    window.onunhandledrejection = function (event) {
        const reason = event && event.reason;
        const rec = {
            ts: Date.now(),
            context: 'content-script',
            type: 'unhandledrejection',
            message: (reason && reason.message) ? reason.message : String(reason),
            stack: (reason && reason.stack) ? reason.stack : null
        };
        console.error('[Mephisto][content-script][unhandledrejection]', rec);
        storeRecord(rec);
    };
})();

window.onload = () => {
    console.log('Mephisto is listening!');
    const siteMap = {
        'lichess.org': 'lichess',
        'www.chess.com': 'chesscom',
        'blitztactics.com': 'blitztactics'
    };
    site = siteMap[window.location.hostname];
    pullConfig();
    // expose diagnostics helpers on the window object without inline script injection
    try {
        window.collectStartPosDiagnostics = collectStartPosDiagnostics;
        window.logStartPosDiagnostics = logStartPosDiagnostics;
    } catch (e) {
        console.warn('collectStartPosDiagnostics attach failed', e);
    }

    determineStartPosition();
};

// Helper: ensure the board and pieces are present before attempting autoplay
function ensurePositionReady(timeout = 5000) {
    return new Promise((resolve) => {
        try {
            if (getBoard() && getPieces()?.length) return resolve(true);
        } catch (e) {
            // continue to observer
        }

        let resolved = false;
        const obs = new MutationObserver(() => {
            try {
                if (getBoard() && getPieces()?.length) {
                    if (!resolved) {
                        resolved = true;
                        obs.disconnect();
                        resolve(true);
                    }
                }
            } catch (e) {
                // ignore
            }
        });

        try {
            obs.observe(document.body, { childList: true, subtree: true, attributes: true });
        } catch (e) {
            // failing to observe -> fallback to interval
            let retry = 0;
            const intervalId = setInterval(() => {
                try {
                    if (getBoard() && getPieces()?.length) {
                        clearInterval(intervalId);
                        resolved = true;
                        return resolve(true);
                    }
                } catch (e) {}
                if (++retry * 100 >= timeout) {
                    clearInterval(intervalId);
                    resolved = true;
                    // diagnostic logging when fallback polling gives up
                    logStartPosDiagnostics('ensurePositionReady: polling fallback timeout — selectors failing');
                    return resolve(false);
                }
            }, 100);
            return;
        }

        // fallback timeout
        setTimeout(() => {
            if (!resolved) {
                resolved = true;
                try { obs.disconnect(); } catch (e) {}
                // diagnostic logging when observer timeout occurs
                logStartPosDiagnostics('ensurePositionReady: observer timeout — selectors failing');
                resolve(false);
            }
        }, timeout);
    });
}

chrome.runtime.onMessage.addListener((response, sender, sendResponse) => {
    // quick ping/ack support so popup can detect content-script presence
    if (response && response.ping) {
        try { sendResponse({ pong: true }); } catch (e) { /* ignore */ }
        return true;
    }
    if (moving) return;
    if (response.queryfen) {
        if (!config) return;
        const res = tryScrapePosition();
        const orient = getOrientation();
        chrome.runtime.sendMessage({ dom: res, orient: orient, fenresponse: true });
    } else if (response.automove) {
        // Ensure the board is present before attempting to autoplay
            (async () => {
                const timeouts = [3000, 5000, 10000];
                let ready = false;
                for (let i = 0; i < timeouts.length; i++) {
                    try {
                        const t = timeouts[i];
                        // eslint-disable-next-line no-await-in-loop
                        ready = await ensurePositionReady(t);
                        if (ready) break;
                        console.warn(`Autoplay ensurePositionReady attempt ${i + 1} failed (timeout ${t}ms)`);
                        logStartPosDiagnostics(`autoplay: ensurePositionReady attempt ${i + 1} failed`);
                    } catch (e) {
                        console.error('Autoplay ensurePositionReady error', e);
                    }
                }
                if (!ready) {
                    console.error('Autoplay aborted: board/pieces not ready after retries');
                    logStartPosDiagnostics('autoplay: aborted after retries — board/pieces not ready');
                    return;
                }

                toggleMoving();
                if (config.puzzle_mode) {
                    console.log(response.pv);
                    simulatePvMoves(response.pv).finally(toggleMoving);
                } else {
                    console.log(response.move);
                    simulateMove(response.move).finally(toggleMoving);
                }
            })();
    } else if (response.pushConfig) {
        console.log(response.config);
        config = response.config;
    } else if (response.consoleMessage) {
        console.log(response.consoleMessage);
    }
});

function tryScrapePosition() {
    try {
        return scrapePosition();
    } catch (e) {
        return 'no'; // skip the current attempt, if we can't scrape
    }
}

function scrapePosition() {
    if (!getBoard()) return;

    let prefix = '';
    if (site === 'chesscom') {
        prefix += '***cc'
    } else if (site === 'lichess') {
        prefix += '***li'
    } else if (site === 'blitztactics') {
        prefix += '***bt'
    }

    let res;
    if (config.variant === 'chess') {
        const moveContainer = getMoveContainer();
        if (moveContainer != null) {
            prefix += 'fen***';
            res = scrapePositionFen();
        } else {
            prefix += 'puz***';
            res = scrapePositionPuz();
        }
    } else {
        prefix += 'var***';
        if (config.variant === 'fischerandom') {
            const startPos = readStartPos(location.href)?.position || DEFAULT_POSITION;
            res = startPos + '&*****';
        }
        const moves = getMoveRecords();
        res += (moves?.length) ? scrapePositionFen(moves) : '?';
    }

    if (res != null) {
        console.log(prefix + res.replace(/[^\w-+#*@&]/g, ''));
        return prefix + res.replace(/[^\w-+=#*@&]/g, '');
    } else {
        return 'no';
    }
}

function scrapePositionFen() {
    let res = '';
    const selectedMove = getSelectedMoveRecord();
    if (!config.simon_says_mode && !selectedMove) {
        return res;
    }
    if (site === 'chesscom') {
        for (const moveWrapper of getMoveRecords()) {
            const move = moveWrapper.lastElementChild
            if (move.lastElementChild?.classList.contains('icon-font-chess')) {
                res += move.lastElementChild.getAttribute('data-figurine') + move.innerText + '*****';
            } else {
                res += move.innerText + '*****';
            }
            if (!config.simon_says_mode && move === selectedMove) {
                break;
            }
        }
    } else if (site === 'lichess') {
        for (const move of getMoveRecords()) {
            res += move.innerText.replace(/\n.*/, '') + '*****';
            if (!config.simon_says_mode && move === selectedMove) {
                break;
            }
        }
    }
    return res;
}

function scrapePositionPuz() {
    if (isAnimating()) {
        throw Error("Board is animating. Can't scrape.")
    }
    let res = '';
    if (site === 'chesscom') {
        for (const piece of getPieces()) {
            const cls = Array.from(piece.classList || []);
            // Heuristic: one class encodes color+type (e.g. 'wp' or 'bp'), another encodes square (e.g. 'square-11')
            let colorTypeClass = cls[1] || cls[0] || '';
            let coordsClass = cls[2] || cls[1] || '';

            // Try to locate a "square" class if our assumptions are wrong
            if (!coordsClass || !coordsClass.includes('square')) {
                coordsClass = cls.find(c => c && c.includes('square')) || coordsClass;
            }

            // Try to locate a color/type class if missing or malformed
            if (!colorTypeClass || typeof colorTypeClass !== 'string' || colorTypeClass.length < 2) {
                colorTypeClass = cls.find(c => c && (/^[wb][prnbkq]/i.test(c) || /(white|black)/i.test(c) || /(pawn|rook|knight|bishop|queen|king)/i.test(c))) || colorTypeClass;
            }

            if (!coordsClass || !colorTypeClass) {
                console.debug('scrapePositionPuz: skipping piece with unexpected classes', cls);
                continue;
            }

            // Derive color and type robustly
            let color = colorTypeClass[0];
            let type = colorTypeClass[1];
            if (!type || !/[prnbkq]/i.test(type)) {
                if (/pawn/i.test(colorTypeClass)) type = 'p';
                else if (/rook/i.test(colorTypeClass)) type = 'r';
                else if (/knight/i.test(colorTypeClass)) type = 'n';
                else if (/bishop/i.test(colorTypeClass)) type = 'b';
                else if (/queen/i.test(colorTypeClass)) type = 'q';
                else if (/king/i.test(colorTypeClass)) type = 'k';
                else {
                    const typeCls = cls.find(c => /(pawn|rook|knight|bishop|queen|king|p|r|n|b|q|k)/i.test(c) && !/square/i.test(c));
                    if (typeCls) {
                        if (/pawn/i.test(typeCls) || typeCls === 'p') type = 'p';
                        else if (/rook/i.test(typeCls) || typeCls === 'r') type = 'r';
                        else if (/knight/i.test(typeCls) || typeCls === 'n') type = 'n';
                        else if (/bishop/i.test(typeCls) || typeCls === 'b') type = 'b';
                        else if (/queen/i.test(typeCls) || typeCls === 'q') type = 'q';
                        else if (/king/i.test(typeCls) || typeCls === 'k') type = 'k';
                    }
                }
            }

            if (!type || !color) {
                console.debug('scrapePositionPuz: could not determine piece color/type', cls);
                continue;
            }

            const coordsStr = (coordsClass && coordsClass.split('-')[1]) || '';
            if (!coordsStr || coordsStr.length < 2) {
                console.debug('scrapePositionPuz: invalid coords class', coordsClass);
                continue;
            }
            const coords = String.fromCharCode('a'.charCodeAt(0) + parseInt(coordsStr[0]) - 1) + coordsStr[1];
            res += `${color}-${type}-${coords}*****`;
        }
    } else {
        const pieceMap = {pawn: 'p', rook: 'r', knight: 'n', bishop: 'b', queen: 'q', king: 'k'};
        const colorMap = {white: 'w', black: 'b'};
        for (const piece of getPieces()) {
            let transform;
            if (piece.classList.contains('dragging')) {
                transform = document.querySelector('.ghost').style.transform;
            } else {
                transform = piece.style.transform;
            }
            const xyCoords = transform.substring(transform.indexOf('(') + 1, transform.length - 1)
                .replaceAll('px', '').replace(' ', '').split(',')
                .map(num => Number(num) / piece.getBoundingClientRect().width + 1);
            const coords = (getOrientation() === 'black')
                ? String.fromCharCode('h'.charCodeAt(0) - xyCoords[0] + 1) + xyCoords[1]
                : String.fromCharCode('a'.charCodeAt(0) + xyCoords[0] - 1) + (9 - xyCoords[1]);
            if (piece.classList[0] !== 'ghost') {
                res += `${colorMap[piece.classList[0]]}-${pieceMap[piece.classList[1]]}-${coords}*****`;
            }
        }
    }
    return (res) ? getTurn() + '*****' + res : null;
}

function getOrientation() {
    let orientedBlack = true;
    if (site === 'chesscom') {
        // Primary method: read the top-left coordinate element (light square label)
        const topLeftCoord = document.querySelector('.coordinate-light')
            || document.querySelector('.coords-light');
        orientedBlack = topLeftCoord && topLeftCoord.innerHTML === '1';

        // Fallback: if coordinate element is absent or ambiguous, infer orientation
        // by checking where white pieces are located on the board.
        if (!topLeftCoord) {
            try {
                const board = getBoard();
                const pieces = Array.from(getPieces());
                // find any unmistakable white piece class token (starts with 'w' followed by piece letter)
                const whitePiece = pieces.find(p => Array.from(p.classList).some(c => /^w[prnbkq]/i.test(c)));
                if (whitePiece && board) {
                    const boardBounds = board.getBoundingClientRect();
                    const pieceBounds = whitePiece.getBoundingClientRect();
                    const pieceCenterY = pieceBounds.y + pieceBounds.height / 2;
                    // if white piece center is below board center, white is at bottom -> orientation 'white'
                    orientedBlack = !(pieceCenterY > (boardBounds.y + boardBounds.height / 2));
                }
            } catch (e) {
                // keep existing behavior on error
            }
        }
    } else if (site === 'lichess') {
        const topLeftCoord = document.querySelector('.files');
        orientedBlack = topLeftCoord && topLeftCoord.classList.contains('black');
    } else if (site === 'blitztactics') {
        const topLeftCoord = document.querySelector('.files');
        orientedBlack = topLeftCoord && topLeftCoord.classList.contains('black');
    }
    return (orientedBlack) ? 'black' : 'white';
}

function toggleMoving() {
    moving = !moving;
}

function pullConfig() {
    chrome.runtime.sendMessage({ pullConfig: true });
}

// -------------------------------------------------------------------------------------------

function getSelectedMoveRecord() {
    let selectedMove;
    if (site === 'chesscom') {
        selectedMove = document.querySelector('.node .selected') // vs player + computer (new)
            || document.querySelector('.move-node-highlighted .move-text-component') // vs player + computer (old)
            || document.querySelector('.move-node.selected .move-text'); // analysis
    } else if (site === 'lichess') {
        selectedMove = document.querySelector('kwdb.a1t')
            || document.querySelector('move.active');
    }
    return selectedMove;
}

function getMoveRecords() {
    let moves;
    if (site === 'chesscom') {
        // common/specific selectors
        moves = document.querySelectorAll('.node');
        if (moves.length === 0) moves = document.querySelectorAll('.move-text-component');
        if (moves.length === 0) moves = document.querySelectorAll('.move-text');

        // shadow DOM fallback
        if (moves.length === 0) {
            const wc = document.querySelector('wc-chess-board');
            const sr = wc && wc.shadowRoot;
            if (sr) moves = sr.querySelectorAll('.node') || sr.querySelectorAll('.move-text-component') || sr.querySelectorAll('.move-text') || [];
        }

        // broad heuristic: any element with class containing 'move' and innerText that looks like SAN
        if (moves.length === 0) {
            const cand = Array.from(document.querySelectorAll('[class*="move"], [id*="move"], [data-test*="move"]'))
                .filter(el => el.innerText && /[KQRNB]?[a-h]?[1-8]?x?[a-h][1-8](=[QRNB])?|O-O(-O)?/.test(el.innerText.trim()));
            if (cand.length) moves = cand;
        }

        // iframe same-origin fallback
        if (moves.length === 0) {
            for (const f of Array.from(document.querySelectorAll('iframe'))) {
                try {
                    const doc = f.contentDocument;
                    if (!doc) continue;
                    const m = doc.querySelectorAll('.node, .move-text-component, .move-text');
                    if (m && m.length) { moves = m; break; }
                } catch (e) { /* cross-origin iframe -> skip */ }
            }
        }
    } else if (site === 'lichess') {
        moves = document.querySelectorAll('kwdb');
        if (moves.length === 0) moves = document.querySelectorAll('move');
    }
    return moves || [];
}

function getMoveContainer() {
    let moveContainer;
    if (site === 'chesscom') {
        moveContainer = document.querySelector('wc-simple-move-list') || document.querySelector('wc-move-list') || document.querySelector('wc-embedded-list') || document.querySelector('.move-list') || document.querySelector('.moves');
        if (!moveContainer) {
            const wc = document.querySelector('wc-chess-board');
            const sr = wc && wc.shadowRoot;
            if (sr) moveContainer = sr.querySelector('wc-simple-move-list') || sr.querySelector('wc-move-list') || sr.querySelector('.move-list') || sr.querySelector('.moves');
        }

        if (!moveContainer) {
            // broad search: element that contains many child nodes that look like SAN moves
            const candidates = Array.from(document.querySelectorAll('div, ol, ul')).filter(el => {
                const text = el.innerText || '';
                const matches = text.split(/\n+/).filter(line => /[a-h][1-8]/.test(line));
                return matches.length >= 2;
            });
            if (candidates.length) moveContainer = candidates[0];
        }
    } else if (site === 'lichess') {
        moveContainer = document.querySelector('l4x') || document.querySelector('.tview2');
    }
    return moveContainer;
}

function getLastMoveHighlights() {
    let fromSquare, toSquare;
    if (site === 'chesscom') {
        const board = getBoard();
        let highlights = Array.from(document.querySelectorAll('.highlight'));
        if (highlights.length === 3) {
            // If there are 3 highlights, we need to figure out which of them is a user action.
            // Either a piece is being dragged or a piece was clicked and let go.
            const dragPiece = board.querySelector('.piece.dragging');
            if (dragPiece) {
                const dragSquareId = dragPiece.className.match('square-[0-9][0-9]')[0];
                highlights = highlights.filter(ht => !ht.classList.contains(dragSquareId));
            } else {
                const hoverSquare = board.querySelector('.hover-square');
                const hoverSquareId = hoverSquare.className.match('square-[0-9][0-9]')[0];
                highlights = highlights.filter(ht => !ht.classList.contains(hoverSquareId));
            }
        }
        [fromSquare, toSquare] = [highlights[0], highlights[1]];
        const toPiece = document.querySelector(`.piece.${toSquare.classList[1]}`);
        if (!toPiece) {
            [fromSquare, toSquare] = [toSquare, fromSquare];
        }
    } else if (site === 'lichess') {
        [toSquare, fromSquare] = Array.from(document.querySelectorAll('.last-move'));
        const toPiece = Array.from(document.querySelectorAll('.main-board piece'))
            .filter(piece => !!piece.classList[1])
            .find(piece => piece.style.transform === toSquare.style.transform);
        if (!toPiece) {
            [toSquare, fromSquare] = [fromSquare, toSquare];
        }
    } else if (site === 'blitztactics') {
        [fromSquare, toSquare] = [document.querySelector('.move-from'), document.querySelector('.move-to')];
    }

    if (!fromSquare || !toSquare) {
        throw Error('Last move highlights not found');
    }
    return [fromSquare, toSquare];
}

function getTurn() {
    let toSquare;
    try {
        toSquare = getLastMoveHighlights()[1];
    } catch (e) {
        if (getMoveContainer()) {
            return 'w'; // if starting position, white goes first
        } else {
            return (getOrientation() === 'black') ? 'w' : 'b'; // if puzzle, the opposite player moves first
        }
    }

    let turn;
    if (site === 'chesscom') {
        const hlPiece = document.querySelector(`.piece.${toSquare.classList[1]}`);
        const hlColorType = Array.from(hlPiece.classList).find(c => c.match(/[wb][prnbkq]/));
        turn = (hlColorType[0] === 'w') ? 'b' : 'w';
    } else if (site === 'lichess') {
        const toPiece = Array.from(document.querySelectorAll('.main-board piece'))
            .filter(piece => !!piece.classList[1])
            .find(piece => piece.style.transform === toSquare.style.transform);
        turn = (toPiece.classList.contains('white')) ? 'b' : 'w';
    } else if (site === 'blitztactics') {
        const toPiece = Array.from(document.querySelectorAll('.board-area piece'))
            .filter(piece => !!piece.classList[1])
            .find(piece => piece.style.transform === toSquare.style.transform);
        turn = (toPiece.classList.contains('white')) ? 'b' : 'w';
    }
    return turn;
}

function getRanksFiles() {
    let fileCoords, rankCoords;
    if (site === 'chesscom') {
        const coords = Array.from(document.querySelectorAll('.coordinates text'));
        fileCoords = coords.slice(8);
        rankCoords = coords.slice(0, 8);
        if (fileCoords.length === 0 || rankCoords.length === 0) {
            fileCoords = Array.from(document.querySelectorAll('.letter'));
            rankCoords = Array.from(document.querySelectorAll('.number'));
        }
    } else if (site === 'lichess') {
        fileCoords = Array.from(document.querySelector('.files').children);
        rankCoords = Array.from(document.querySelector('.ranks').children);
    } else if (site === 'blitztactics') {
        fileCoords = Array.from(document.querySelector('.files').children);
        rankCoords = Array.from(document.querySelector('.ranks').children);
    }
    return [rankCoords, fileCoords];
}

function getBoard() {
    let board;
    if (site === 'chesscom') {
        // Try known selectors
        board = document.querySelector('.board') || document.querySelector('.board-root') || document.querySelector('.wc-board') || document.querySelector('wc-chess-board') || document.querySelector('.game-board') || document.querySelector('.board-wrapper');
        // shadow DOM inside wc-chess-board
        const wc = document.querySelector('wc-chess-board') || document.querySelector('wc-chessboard') || document.querySelector('wc-board');
        if (wc && wc.shadowRoot) {
            board = wc.shadowRoot.querySelector('.board') || wc.shadowRoot.querySelector('.board-root') || wc.shadowRoot.querySelector('.wc-board') || board;
        }

        // broad heuristic: find element with class or id containing 'board' and reasonable size
        if (!board) {
            const candidates = Array.from(document.querySelectorAll('[class*="board"], [id*="board"], [data-test*="board"]'))
                .filter(el => {
                    const r = el.getBoundingClientRect ? el.getBoundingClientRect() : {width:0,height:0};
                    return r.width >= 100 && r.height >= 100;
                });
            if (candidates.length) board = candidates[0];
        }

        // canvas fallback (some sites draw board on canvas)
        if (!board) {
            const canv = Array.from(document.querySelectorAll('canvas')).find(c => {
                const r = c.getBoundingClientRect();
                return r.width >= 200 && r.height >= 200;
            });
            if (canv) board = canv;
        }

        // iframe same-origin fallback
        if (!board) {
            for (const f of Array.from(document.querySelectorAll('iframe'))) {
                try {
                    const doc = f.contentDocument;
                    if (!doc) continue;
                    const b = doc.querySelector('.board') || doc.querySelector('.wc-board') || doc.querySelector('.game-board');
                    if (b) { board = b; break; }
                } catch (e) { /* cross-origin -> skip */ }
            }
        }
    } else if (site === 'lichess') {
        board = document.querySelector('.main-board') || document.querySelector('.cg-board') || document.querySelector('.board-wrap');
    } else if (site === 'blitztactics') {
        board = document.querySelector('.chessground-board');
    }
    return board;
}

function getPieces() {
    if (site === 'chesscom') {
        // try existing global pieces
        let pieces = Array.from(document.querySelectorAll('.piece'));
        if (pieces.length === 0) {
            // try broad class match in document
            pieces = Array.from(document.querySelectorAll('[class*="piece"], [data-piece], img[src*="pieces"], svg .piece'));
        }
        // try shadow DOM pieces
        if (pieces.length === 0) {
            const wc = document.querySelector('wc-chess-board') || document.querySelector('wc-chessboard');
            const sr = wc && wc.shadowRoot;
            if (sr) pieces = Array.from(sr.querySelectorAll('.piece'));
        }
        // if still none, check for canvas-based boards (no discrete pieces) -> return empty array
        return pieces || [];
    } else {
        // Try multiple selectors / fallbacks for lichess/blitztactics and generic cases.
        const board = getBoard();
        const selectors = [
            '.main-board piece',
            '.cg-board piece',
            '.cg-board .piece',
            '.piece',
            '.cg-piece',
            '.board-area piece',
            '.board-area .piece',
            '[class*="piece"]',
            'svg [class*="piece"]'
        ];

        let pieces = [];
        for (const sel of selectors) {
            try {
                const found = board ? Array.from(board.querySelectorAll(sel)) : Array.from(document.querySelectorAll(sel));
                if (found && found.length) { pieces = found; break; }
            } catch (e) {
                // ignore invalid selectors
            }
        }

        // Tag-name fallback (custom 'piece' elements)
        if (pieces.length === 0) {
            try { pieces = Array.from(document.getElementsByTagName('piece') || []); } catch (e) {}
        }

        // Final filter: ensure elements look like pieces
        pieces = pieces.filter(p => {
            try {
                if (!p) return false;
                const tag = p.tagName && p.tagName.toLowerCase();
                const cls = (p.className || '').toString().toLowerCase();
                return tag === 'piece' || cls.includes('piece') || (p.classList && p.classList.length > 0);
            } catch (e) { return false; }
        });

        return pieces || [];
    }
}

function getPromotionSelection(promotion) {
    let promotions;
    if (site === 'chesscom') {
        const promotionElems = document.querySelectorAll('.promotion-piece');
        if (promotionElems.length) promotions = promotionElems;
    } else if (site === 'lichess') {
        const promotionModal = document.querySelector('#promotion-choice');
        if (promotionModal) promotions = promotionModal.children;
    } else if (site === 'blitztactics') {
        promotions = document.querySelector('.pieces').children;
    }

    const promoteMap = (site === 'chesscom')
        ? { 'b': 0, 'n': 1, 'q': 2, 'r': 3 }
        : (site === 'lichess')
            ? { 'q': 0, 'n': 1, 'r': 2, 'b': 3 }
            : { 'q': 0, 'r': 1, 'n': 2, 'b': 3 };
    const idx = promoteMap[promotion];
    return (promotions) ? promotions[idx] : undefined;
}

function isAnimating() {
    let anim;
    if (site === 'chesscom') {
        anim = getBoard().getAttribute('data-test-animating');
    } else if (site === 'lichess' || site === 'blitztactics') {
        anim = getBoard().querySelector('piece.anim');
    }
    return !!anim;
}

// -------------------------------------------------------------------------------------------

function loadStartPosCache() {
    const cache = new LRU(10);
    const entries = JSON.parse(localStorage.getItem(LOCAL_CACHE)) || [];
    for (const entry of entries.reverse()) {
        cache.set(entry.key, entry.value);
    }
    return cache;
}

function saveStartPosCache() {
    localStorage.setItem(LOCAL_CACHE, JSON.stringify(startPosCache.toJSON()));
}

function readStartPos(url) {
    const startPos = startPosCache.get(url);
    saveStartPosCache();
    return startPos;
}

function writeStartPos(url, startPos) {
    startPosCache.set(url, startPos);
    saveStartPosCache();
}

function isGameUrl() {
    // lichess: /gameId, /puzzles, /training, /analysis, etc.
    const lichessGamePattern = /^\/[a-zA-Z0-9]{8,}(\?|#|\/|$)|^\/([a-z]+\/)?[a-zA-Z0-9]{8,}/;
    // chesscom: /game/live/..., /game/rapid/..., /analysis, /pti, etc.
    const chesscomGamePattern = /^\/game|^\/analysis|^\/pti|^\/play\//;
    // blitztactics: /play, /train, etc.
    const blitztacticsGamePattern = /^\/play|^\/train/;
    
    const path = window.location.pathname;
    if (site === 'lichess') return lichessGamePattern.test(path);
    if (site === 'chesscom') return chesscomGamePattern.test(path);
    if (site === 'blitztactics') return blitztacticsGamePattern.test(path);
    return false;
}

function determineStartPosition() {
    startPosCache = loadStartPosCache();

    // quick synchronous check in case elements are already present
    if (getBoard() && getPieces()?.length) {
        onPositionLoad();
        return;
    }

    // Skip board detection on non-game pages (home, lobby, analysis, etc. without a live board)
    if (!isGameUrl()) {
        console.log('Mephisto: skipping board detection (not a game URL)');
        return;
    }

    // Use a MutationObserver to detect when the board/pieces are added to the DOM.
    // This immedately reacts to dynamic page changes and avoids polling delays.
    let fallbackTimeoutId;
    const observer = new MutationObserver((mutationsList, obs) => {
        try {
            if (getBoard() && getPieces()?.length) {
                obs.disconnect();
                if (fallbackTimeoutId) clearTimeout(fallbackTimeoutId);
                onPositionLoad();
            }
        } catch (e) {
            // ignore transient errors and keep observing
        }
    });

    // Start observing the whole document body for structural changes/attribute updates
    try {
        observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    } catch (e) {
        // If observing fails for any reason, fall back to a polling approach
        let retryCount = 0;
        const intervalId = setInterval(() => {
            if (getBoard() && getPieces()?.length) {
                clearInterval(intervalId);
                onPositionLoad();
            }
            if (++retryCount >= 50) { // ~5s
                // diagnostic logging when polling fallback gives up
                logStartPosDiagnostics('determineStartPosition: polling fallback timeout after ~5s');
                console.error('Unable to determine starting position (polling fallback timeout after ~5s)');
                clearInterval(intervalId);
            }
        }, 100);
        return;
    }

    // Fallback: give up after 8s and log an error (but do one final check)
    fallbackTimeoutId = setTimeout(() => {
        observer.disconnect();
        if (getBoard() && getPieces()?.length) {
            onPositionLoad();
        } else {
            // diagnostic logging when observer times out
            logStartPosDiagnostics('determineStartPosition: observer timeout after ~8s');
            console.error('Unable to determine starting position (timeout after ~8s)');
        }
    }, 8000);
}

function onPositionLoad() {
    // cache position, if it's a non-standard starting position
    if (!getMoveRecords()?.length) { // is stating position?
        const position = scrapePositionPuz();
        if (position !== DEFAULT_POSITION) { // is non-standard?
            writeStartPos(location.href, {
                position: position,
                timestamp: Date.now()
            })
        }
    }
}

// -------------------------------------------------------------------------------------------

function promiseTimeout(time) {
    return new Promise((resolve) => {
        setTimeout(() => resolve(time), time);
    });
}

function getOffsetCorrectionXY() {
    if (config.python_autoplay_backend) {
        return getBrowserOffsetXY();
    }
    return [0, 0];
}

function getBrowserOffsetXY() {
    const topBarHeight = window.outerHeight - window.innerHeight;
    const offsetX = window.screenX;
    const offsetY = window.screenY + topBarHeight;
    return [offsetX, offsetY];
}

function getRandomSampledXY(bounds, range = 0.8) {
    const margin = (1 - range) / 2;
    const x = bounds.x + (range * Math.random() + margin) * bounds.width;
    const y = bounds.y + (range * Math.random() + margin) * bounds.height;
    const [correctX, correctY] = getOffsetCorrectionXY();
    return [x + correctX, y + correctY];
}

// -------------------------------------------------------------------------------------------

function dispatchSimulateClick(x, y) {
    console.log([x, y]);
    chrome.runtime.sendMessage({
        click: true,
        x: x,
        y: y
    });
}

function simulateClickSquare(bounds, range = 0.8) {
    const [x, y] = getRandomSampledXY(bounds, range);
    dispatchSimulateClick(x, y);
}

function simulateMove(move) {
    const boardBounds = getBoard().getBoundingClientRect();
    const orientation = getOrientation();

    function getBoundsFromCoords(coords) {
        const squareSide = boardBounds.width / 8;
        const [xIdx, yIdx] = (orientation === 'white')
            ? [coords[0].charCodeAt(0) - 'a'.charCodeAt(0), 8 - parseInt(coords[1])]
            : ['h'.charCodeAt(0) - coords[0].charCodeAt(0), parseInt(coords[1]) - 1];
        return new DOMRect(boardBounds.x + xIdx * squareSide, boardBounds.y + yIdx * squareSide, squareSide, squareSide);
    }

    function getThinkTime() {
        return config.think_time + Math.random() * config.think_variance;
    }

    function getMoveTime() {
        return config.move_time + Math.random() * config.move_variance;
    }

    async function performSimulatedMoveClicks() {
        simulateClickSquare(getBoundsFromCoords(move.substring(0, 2)));
        await promiseTimeout(getMoveTime());
        simulateClickSquare(getBoundsFromCoords(move.substring(2)));
    }

    async function performSimulatedMoveSequence() {
        await promiseTimeout(getThinkTime());
        await performSimulatedMoveClicks();
        if (move[4]) {
            await promiseTimeout(getMoveTime());
            await simulatePromotionClicks(move[4]); // conditional promotion click
        }
    }

    return performSimulatedMoveSequence();
}

function simulatePvMoves(pv) {
    // Guard against malformed/empty PV data from the message payload.
    if (!Array.isArray(pv) || pv.length === 0) {
        console.warn('simulatePvMoves: invalid PV payload', pv);
        return Promise.resolve(false);
    }

    const boardBounds = getBoard().getBoundingClientRect();

    function deriveLastMove() {
        function deriveCoords(square) {
            if (!square) return 'no';
            const squareBounds = square.getBoundingClientRect();
            const xIdx = Math.floor(((squareBounds.x + 1) - boardBounds.x) / squareBounds.width);
            const yIdx = Math.floor(((squareBounds.y + 1) - boardBounds.y) / squareBounds.height);
            return getOrientation() === 'white'
                ? String.fromCharCode('a'.charCodeAt(0) + xIdx) + (8 - yIdx)
                : String.fromCharCode('h'.charCodeAt(0) - xIdx) + (yIdx + 1);
        }

        const [fromSquare, toSquare] = getLastMoveHighlights();
        return deriveCoords(fromSquare) + deriveCoords(toSquare);
    }

    async function confirmResponse(move, lastMove) {
        let runtime = 0;
        while (runtime < 10000) { // < 10 seconds
            runtime += await promiseTimeout(config.fen_refresh);
            try {
                const observedLastMove = deriveLastMove();
                if (observedLastMove !== lastMove) {
                    return observedLastMove === move;
                }
            } catch (error) {
                // retry on failure
            }
        }
        return false;
    }

    async function performSimulatedPvMoveSequence() {
        for (let i = 0; i < pv.length; i++) {
            let lastMove = pv[i - 1];
            let move = pv[i];
            if (!move || typeof move !== 'string' || move.length < 4) {
                console.warn('simulatePvMoves: skipping invalid move in PV', move, 'at index', i);
                continue;
            }
            if (i % 2 === 0) { // even index -> my move
                await simulateMove(move);
            } else { // odd index -> their move
                if (!await confirmResponse(move, lastMove)) return;
            }
        }
        return true;
    }

    return performSimulatedPvMoveSequence();
}

async function simulatePromotionClicks(promotion) {
    const promotionChoice = getPromotionSelection(promotion);
    if (promotionChoice) {
        await simulateClickSquare(promotionChoice.getBoundingClientRect())
    }
}

// Diagnostic helper: collect info about board/piece selectors and DOM for debugging
function collectStartPosDiagnostics() {
    const info = {url: location.href, site};
    try {
        info.getBoard_query = !!document.querySelector('.board');
        info.getPieces_query_len = document.querySelectorAll('.piece')?.length || 0;
        info.getMainBoard_query = !!document.querySelector('.main-board');
        info.getMainBoard_piece_len = document.querySelectorAll('.main-board piece')?.length || 0;
        info.moveContainer_exists = !!getMoveContainer();
        info.moveRecords_len = (getMoveRecords() && getMoveRecords().length) ? getMoveRecords().length : 0;
        info.sample_board_outer = (() => {
            const b = document.querySelector('.board') || document.querySelector('.main-board') || document.querySelector('.chessground-board');
            return b ? (b.outerHTML ? b.outerHTML.substring(0, 300) : String(b)) : null;
        })();
    } catch (e) {
        info.error = String(e);
    }
    return info;
}

function logStartPosDiagnostics(prefix) {
    const diag = collectStartPosDiagnostics();
    try {
        console.error(prefix, JSON.stringify(diag, null, 2));
    } catch (e) {
        // fallback in case of circular refs
        console.error(prefix, diag);
    }
}
