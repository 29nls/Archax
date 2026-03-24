import {Chess} from '../../lib/chess.js';
import { initGlobalErrorHandlers } from '../util/ErrorLogger.js';

initGlobalErrorHandlers('popup');

let engine;
let board;
let fen_cache;
let config;

let is_calculating = false;
let prog = 0;
let last_eval = {fen: '', activeLines: 0, lines: []};
let turn = ''; // 'w' | 'b'

document.addEventListener('DOMContentLoaded', async function () {
    // load extension configurations from localStorage
    const computeTime = JSON.parse(localStorage.getItem('compute_time'));
    const fenRefresh = JSON.parse(localStorage.getItem('fen_refresh'));
    const thinkTime = JSON.parse(localStorage.getItem('think_time'));
    const thinkVariance = JSON.parse(localStorage.getItem('think_variance'));
    const moveTime = JSON.parse(localStorage.getItem('move_time'));
    const moveVariance = JSON.parse(localStorage.getItem('move_variance'));
    config = {
        // general settings
        engine: JSON.parse(localStorage.getItem('engine')) || 'stockfish-16-nnue-7',
        variant: JSON.parse(localStorage.getItem('variant')) || 'chess',
        compute_time: (computeTime != null) ? computeTime : 3000,
        fen_refresh: (fenRefresh != null) ? fenRefresh : 100,
        multiple_lines: JSON.parse(localStorage.getItem('multiple_lines')) || 1,
        threads: JSON.parse(localStorage.getItem('threads')) || navigator.hardwareConcurrency - 1,
        memory: JSON.parse(localStorage.getItem('memory')) || 32,
        think_time: (thinkTime != null) ? thinkTime : 1000,
        think_variance: (thinkVariance != null) ? thinkVariance : 500,
        move_time: (moveTime != null) ? moveTime : 500,
        move_variance: (moveVariance != null) ? moveVariance : 250,
        computer_evaluation: JSON.parse(localStorage.getItem('computer_evaluation')) || false,
        threat_analysis: JSON.parse(localStorage.getItem('threat_analysis')) || false,
        simon_says_mode: JSON.parse(localStorage.getItem('simon_says_mode')) || false,
        autoplay: JSON.parse(localStorage.getItem('autoplay')) || false,
        puzzle_mode: JSON.parse(localStorage.getItem('puzzle_mode')) || false,
        python_autoplay_backend: JSON.parse(localStorage.getItem('python_autoplay_backend')) || false,
        // appearance settings
        pieces: JSON.parse(localStorage.getItem('pieces')) || 'wikipedia.svg',
        board: JSON.parse(localStorage.getItem('board')) || 'brown',
        coordinates: JSON.parse(localStorage.getItem('coordinates')) || false,
    };
    push_config();

    // init chess board
    document.getElementById('board').classList.add(config.board);
    const [pieceSet, ext] = config.pieces.split('.');
    board = ChessBoard('board', {
        position: 'start',
        pieceTheme: `/res/chesspieces/${pieceSet}/{piece}.${ext}`,
        appearSpeed: 'fast',
        moveSpeed: 'fast',
        showNotation: config.coordinates,
        draggable: false
    });

    // init fen LRU cache
    fen_cache = new LRU(100);

    // init engine webworker
    await initialize_engine();

    // listen to messages from content-script
    chrome.runtime.onMessage.addListener(function (response) {
        if (response.fenresponse && response.dom != null && response.dom !== 'no') {
            if (board.orientation() !== response.orient) {
                board.orientation(response.orient);
            }
            const {fen, startFen, moves} = parse_position_from_response(response.dom);
            if (last_eval.fen !== fen) {
                on_new_pos(fen, startFen, moves);
            }
        } else if (response.pullConfig) {
            push_config();
        } else if (response.click) {
            console.log(response);
            dispatch_click_event(response.x, response.y);
        }
    });

    // query fen periodically from content-script
    request_fen();
    setInterval(function () {
        request_fen();
    }, config.fen_refresh);

    // register button click listeners
    document.getElementById('analyze').addEventListener('click', () => {
        const variantNameMap = {
            'chess': 'standard',
            'fischerandom': 'chess960',
            'crazyhouse': 'crazyhouse',
            'kingofthehill': 'kingOfTheHill',
            '3check': 'threeCheck',
            'antichess': 'antichess',
            'atomic': 'atomic',
            'horde': 'horde',
            'racingkings': 'racingKings',
        }
        const variant = variantNameMap[config.variant];
        window.open(`https://lichess.org/analysis/${variant}?fen=${last_eval.fen}`, '_blank');
    });
    document.getElementById('config').addEventListener('click', () => {
        window.open('/src/options/options.html', '_blank');
    });

    // initialize materialize
    M.Tooltip.init(document.querySelectorAll('.tooltipped'), {});
});

// Robust wrappers for messaging to avoid "Could not establish connection" errors
async function safeQueryTabs(query) {
    return new Promise((resolve, reject) => {
        chrome.tabs.query(query, (tabs) => {
            if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
            resolve(tabs);
        });
    });
}

async function safeSendMessageToTab(tabId, message) {
    return new Promise((resolve, reject) => {
        try {
            chrome.tabs.sendMessage(tabId, message, (resp) => {
                if (chrome.runtime.lastError) {
                        // Treat common benign errors (no receiver / closed port) as non-fatal.
                        const msg = chrome.runtime.lastError.message || '';
                        // Log benign errors at debug level to avoid alarming the user.
                        if (msg.includes('No recipient') || msg.includes('Could not establish connection') || msg.includes('The message port closed before a response was received')) {
                            console.debug('safeSendMessageToTab: benign sendMessage failure:', msg);
                            return resolve(null);
                        }
                        console.warn('safeSendMessageToTab: sendMessage failed:', msg);
                        return reject(chrome.runtime.lastError);
                    }
                resolve(resp);
            });
        } catch (e) {
            reject(e);
        }
    });
}

// Telemetry helpers (stored under 'mephisto_metrics')
function incrMetric(key) {
    try {
        const storageKey = 'mephisto_metrics';
        chrome.storage.local.get([storageKey], (res) => {
            const obj = (res && res[storageKey]) ? res[storageKey] : {};
            obj[key] = (obj[key] || 0) + 1;
            try { chrome.storage.local.set({ [storageKey]: obj }); } catch (e) { /* ignore */ }
        });
    } catch (e) { /* ignore */ }
}

// Programmatic injection helper for MV3 using chrome.scripting
function injectContentScriptOnce(tabId) {
    return new Promise((resolve) => {
        try {
            if (chrome.scripting && chrome.scripting.executeScript) {
                incrMetric('injectionsAttempted');
                chrome.scripting.executeScript({ target: { tabId: tabId }, files: ['lib/lru.min.js', 'src/scripts/content-script.js'] }, (results) => {
                    if (chrome.runtime.lastError) {
                        console.debug('injectContentScriptOnce failed:', chrome.runtime.lastError.message);
                        return resolve(false);
                    }
                    incrMetric('injectionsSucceeded');
                    resolve(true);
                });
            } else {
                resolve(false);
            }
        } catch (e) {
            console.debug('injectContentScriptOnce exception', e);
            resolve(false);
        }
    });
}

// Replace existing request_fen() to use safe wrappers
async function request_fen() {
    try {
        const tabs = await safeQueryTabs({active: true, currentWindow: true});
        if (!tabs || !tabs[0]) return;
            try {
                const tabId = tabs[0].id;
                // ping first to detect if content-script is present
                let ping = await safeSendMessageToTab(tabId, { ping: true });
                if (ping == null) {
                    // try programmatic injection then ping again
                    const injected = await injectContentScriptOnce(tabId);
                    if (injected) {
                        await new Promise(r => setTimeout(r, 300));
                        ping = await safeSendMessageToTab(tabId, { ping: true });
                    }
                }

                if (ping == null) {
                    // fallback: try queryfen once anyway
                    const resp = await safeSendMessageToTab(tabId, { queryfen: true });
                    if (resp == null) console.debug('request_fen: no content-script receiver after injection/ping');
                } else {
                    const resp = await safeSendMessageToTab(tabId, { queryfen: true });
                    if (resp == null) console.debug('request_fen: ping succeeded but queryfen returned null');
                }
            } catch (err) {
                console.debug('request_fen: no content-script receiver', err.message || err);
                incrMetric('request_fen_errors');
            }
    } catch (err) {
        console.debug('request_fen: unable to query tabs', err.message || err);
    }
}

// Replace other sendMessage usages with safe wrappers
function request_automove(move) {
    let message;
    if (config.puzzle_mode && last_eval && last_eval.lines && last_eval.lines[0] && last_eval.lines[0].pv) {
        const pvStr = last_eval.lines[0].pv;
        const pvArray = typeof pvStr === 'string' ? pvStr.split(' ').filter(m => m) : (Array.isArray(pvStr) ? pvStr : []);
        message = {automove: true, pv: pvArray.length > 0 ? pvArray : [move]};
    } else {
        message = {automove: true, move: move};
    }

    (async () => {
        try {
            const tabs = await safeQueryTabs({active: true, currentWindow: true});
            if (!tabs || !tabs[0]) return;
            const tabId = tabs[0].id;
            const maxAttempts = 8;
            const baseDelayMs = 200; // base for exponential backoff
            let success = false;
            incrMetric('automoveAttempts');

            // try a quick ping first and inject if not present
            try {
                const pingResp = await safeSendMessageToTab(tabId, { ping: true });
                if (pingResp == null) {
                    const injected = await injectContentScriptOnce(tabId);
                    if (injected) await new Promise(r => setTimeout(r, 300));
                }
            } catch (e) { /* ignore */ }

            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                try {
                    const resp = await safeSendMessageToTab(tabId, message);
                    if (resp != null) { success = true; break; }

                    console.debug(`request_automove: no receiver (attempt ${attempt})`);
                    // attempt to inject content-script on first failure
                    if (attempt === 1) {
                        const injected = await injectContentScriptOnce(tabId);
                        if (injected) {
                            await new Promise(r => setTimeout(r, 300));
                            const resp2 = await safeSendMessageToTab(tabId, message);
                            if (resp2 != null) { success = true; break; }
                        }
                    }

                    // exponential backoff before next attempt
                    if (attempt < maxAttempts) {
                        const delay = baseDelayMs * Math.pow(2, attempt - 1);
                        await new Promise(r => setTimeout(r, delay));
                    }
                } catch (err) {
                    console.debug(`request_automove: sendMessage failed (attempt ${attempt})`, err.message || err);
                    if (attempt < maxAttempts) {
                        const delay = baseDelayMs * Math.pow(2, attempt - 1);
                        await new Promise(r => setTimeout(r, delay));
                    }
                }
            }

            if (!success) {
                console.warn('request_automove: all attempts failed');
                incrMetric('automoveFailures');
                // Inform the user that automove failed and suggest checking content-script / backend
                try {
                    if (chrome.notifications && chrome.notifications.create) {
                        chrome.notifications.create({
                            type: 'basic',
                            iconUrl: '/res/icons/icon48.png',
                            title: 'Mephisto: Autoplay failed',
                            message: 'Autoplay failed after multiple attempts. Ensure the extension content script is active or the Python backend is running.'
                        });
                    }
                } catch (e) {
                    console.debug('notification create failed', e);
                }
            }
        } catch (err) {
            console.debug('request_automove: tab query failed', err.message || err);
            incrMetric('automove_tab_query_errors');
        }
    })();
}

function request_console_log(message) {
    (async () => {
        try {
            const tabs = await safeQueryTabs({active: true, currentWindow: true});
            if (!tabs || !tabs[0]) return;
            try {
                const resp = await safeSendMessageToTab(tabs[0].id, {consoleMessage: message});
                if (resp == null) console.debug('request_console_log: no receiver');
            } catch (err) {
                console.debug('request_console_log: no receiver', err.message || err);
            }
        } catch (err) {
            console.debug('request_console_log: tab query failed', err.message || err);
        }
    })();
}

function push_config() {
    (async () => {
        try {
            const tabs = await safeQueryTabs({active: true, currentWindow: true});
            if (!tabs || !tabs[0]) return;
            try {
                const resp = await safeSendMessageToTab(tabs[0].id, {pushConfig: true, config: config});
                if (resp == null) console.debug('push_config: no receiver');
            } catch (err) {
                console.debug('push_config: no receiver', err.message || err);
            }
        } catch (err) {
            console.debug('push_config: tab query failed', err.message || err);
        }
    })();
}

async function initialize_engine() {
    const engineMap = {
        'stockfish-17-nnue-79': 'stockfish-17-79/sf17-79.js',
        'stockfish-16-nnue-40': 'stockfish-16-40/stockfish.js',
        'stockfish-16-nnue-7': 'stockfish-16-7/sf16-7.js',
        'stockfish-11-hce': 'stockfish-11-hce/sfhce.js',
        'stockfish-6': 'stockfish-6/stockfish.js',
        'lc0': 'lc0/lc0.js',
        'fairy-stockfish-14-nnue': 'fairy-stockfish-14/fsf14.js',
    }
    const enginePath = `/lib/engine/${engineMap[config.engine]}`;
    const engineBasePath = enginePath.substring(0, enginePath.lastIndexOf('/'));
    if (['stockfish-16-nnue-40', 'stockfish-6'].includes(config.engine)) {
        engine = new Worker(enginePath);
        engine.onmessage = (event) => on_engine_response(event.data);
    } else if (['stockfish-17-nnue-79', 'stockfish-16-nnue-7', 'fairy-stockfish-14-nnue', 'stockfish-11-hce'].includes(config.engine)) {
        // Detect if WebAssembly threads / SharedArrayBuffer are available. Some environments
        // (extension popups, lack of cross-origin isolation) do not support shared memory.
        let threadsSupported = true;
        try {
            // Feature-detect by attempting to create a shared memory
            new WebAssembly.Memory({initial:1, maximum:1, shared:true});
        } catch (e) {
            threadsSupported = false;
        }

        let module;
        try {
            if (!threadsSupported) throw new Error('WASM threads not supported');
            module = await import(enginePath);
            engine = await module.default();
        } catch (err) {
            console.error('Engine module load failed or threads unsupported:', err.message || err);
            // Fallback: try to use a worker-based engine that doesn't require pthreads
            const fallbackEngine = '/lib/engine/stockfish-16-40/stockfish.js';
            try {
                engine = new Worker(fallbackEngine);
                engine.onmessage = (event) => on_engine_response(event.data);
                console.warn('Falling back to worker-based Stockfish engine (no threads)');
            } catch (err2) {
                console.error('Failed to initialize fallback engine:', err2.message || err2);
                throw err; // rethrow original error to surface failure
            }
        }
        if (config.engine.includes('nnue')) {
            async function fetchNnueModels(engine, engineBasePath) {
                if (config.engine !== 'fairy-stockfish-14-nnue') {
                    const nnues = [];
                    for (let i = 0; ; i++) {
                        let nnue = engine.getRecommendedNnue(i);
                        if (!nnue || nnues.includes(nnue)) break;
                        nnues.push(nnue);
                    }
                    const nnue_responses = await Promise.all(nnues.map(nnue => fetch(`${engineBasePath}/${nnue}`)));
                    return await Promise.all(nnue_responses.map(res => res.arrayBuffer()));
                } else {
                    const variantNnueMap = {
                        'chess': 'nn-46832cfbead3.nnue',
                        'fischerandom': 'nn-46832cfbead3.nnue',
                        'crazyhouse': 'crazyhouse-8ebf84784ad2.nnue',
                        'kingofthehill': 'kingofthehill-978b86d0e6a4.nnue',
                        '3check': '3check-cb5f517c228b.nnue',
                        'antichess': 'antichess-dd3cbe53cd4e.nnue',
                        'atomic': 'atomic-2cf13ff256cc.nnue',
                        'horde': 'horde-28173ddccabe.nnue',
                        'racingkings': 'racingkings-636b95f085e3.nnue',
                    };
                    const variantNnue = variantNnueMap[config.variant];
                    const nnue_response = await fetch(`${engineBasePath}/nnue/${variantNnue}`);
                    return [await nnue_response.arrayBuffer()];
                }
            }

            if (config.engine === 'fairy-stockfish-14-nnue') {
                send_engine_uci(`setoption name UCI_Variant value ${config.variant}`);
            }
            const nnues = await fetchNnueModels(engine, engineBasePath);
            nnues.forEach((model, i) => engine.setNnueBuffer(new Uint8Array(model), i))
        }
        engine.listen = (message) => on_engine_response(message);
    } else if (['lc0'].includes(config.engine)) {
        const lc0Frame = document.createElement('iframe');
        lc0Frame.src = `${engineBasePath}/lc0.html`;
        lc0Frame.style.display = 'none';
        document.body.appendChild(lc0Frame);
        engine = lc0Frame.contentWindow;

        let poll_startup = true
        window.onmessage = () => poll_startup = false;
        while (poll_startup) {
            await promise_timeout(100);
        }

        window.onmessage = event => on_engine_response(event.data);
        let weights = await fetch(`${engineBasePath}/weights/weights_32195.dat.gz`).then(res => res.arrayBuffer());
        engine.postMessage({type: 'weights', data: {name: 'weights_32195.dat.gz', weights: weights}}, '*');
    }

    if (config.engine === 'remote') {
        request_remote_configure({
            "Hash": config.memory,
            "Threads": config.threads,
            "MultiPV": config.multiple_lines,
        });
    } else {
        if (config.engine !== 'stockfish-16-nnue-40' && config.engine !== 'stockfish-6') { // crashes for some reason
            send_engine_uci(`setoption name Hash value ${config.memory}`);
        }
        if (config.engine !== 'stockfish-6') {
            send_engine_uci(`setoption name Threads value ${config.threads}`);
        }
        send_engine_uci(`setoption name MultiPV value ${config.multiple_lines}`);
        send_engine_uci('ucinewgame');
        send_engine_uci('isready');
    }
    console.log('Engine ready!', engine);
}

function send_engine_uci(message) {
    if (config.engine === 'lc0') {
        engine.postMessage(message, '*');
    } else if (engine instanceof Worker) {
        engine.postMessage(message);
    } else if (engine && 'uci' in engine) {
        engine.uci(message);
    }
}

function on_engine_best_move(best, threat, isTerminal=false) {
    if (config.engine === 'remote') {
        last_eval.activeLines = last_eval.lines.length;
    }

    console.log('EVALUATION:', JSON.parse(JSON.stringify(last_eval)));
    const piece_name_map = {P: 'Pawn', R: 'Rook', N: 'Knight', B: 'Bishop', Q: 'Queen', K: 'King'};
    const toplay = (turn === 'w') ? 'White' : 'Black';
    const next = (turn === 'w') ? 'Black' : 'White';
    if (best === '(none)') {
        const pvLine = last_eval.lines[0] || '';
        if ('mate' in pvLine) {
            update_evaluation('Checkmate!');
            if (config.variant === 'antichess') {
                update_best_move(`${toplay} Wins`, '');
            } else {
                update_best_move(`${next} Wins`, '');
            }
        } else {
            update_evaluation('Stalemate!');
            if (config.variant === 'antichess') {
                update_best_move(`${toplay} Wins`, '');
            } else {
                update_best_move('Draw', '');
            }
        }
    } else if (config.simon_says_mode) {
        if (toplay.toLowerCase() === board.orientation()) {
            const startSquare = best.substring(0, 2);
            const startPiece = board.position()[startSquare];
            const startPieceType = (startPiece) ? startPiece.substring(1) : null;
            if (startPieceType) {
                update_best_move(piece_name_map[startPieceType]);
            }
        } else {
            update_best_move('');
        }
    } else {
        if (threat && threat !== '(none)') {
            update_best_move(`${toplay} to play, best move is ${best}`, `Best response for ${next} is ${threat}`);
        } else {
            update_best_move(`${toplay} to play, best move is ${best}`, '');
        }
    }

    if (toplay.toLowerCase() === board.orientation()) {
        last_eval.bestmove = best;
        last_eval.threat = threat;
        if (config.simon_says_mode) {
            const startSquare = best.substring(0, 2);
            if (board.position()[startSquare] == null) {
                // The current best move is stale so abort! This happens when the opponent makes a move in
                // the middle of continuous evaluation: the engine isn't done evaluating the opponent's
                // position and ends up returning the opponent's best move on our turn.
                return;
            }
            const startPiece = board.position()[startSquare].substring(1);
            if (last_eval.lines[0] != null) {
                if ('mate' in last_eval.lines[0]) {
                    request_console_log(`${piece_name_map[startPiece]} ==> #${last_eval.lines[0].mate}`);
                } else {
                    request_console_log(`${piece_name_map[startPiece]} ==> ${last_eval.lines[0].score / 100.0}`);
                }
            }
            if (config.threat_analysis) {
                clear_annotations();
                draw_threat();
            }
        }
        if (config.autoplay && isTerminal) {
            request_automove(best);
        }
    }

    if (!config.simon_says_mode) {
        draw_moves();
        if (config.threat_analysis) {
            draw_threat()
        }
    }

    toggle_calculating(false);
}

function on_engine_evaluation(info) {
    if (!info.lines[0]) return;

    if ('mate' in info.lines[0]) {
        update_evaluation(`Checkmate in ${info.lines[0].mate}`);
    } else {
        update_evaluation(`Score: ${info.lines[0].score / 100.0} at depth ${info.lines[0].depth}`)
    }
}

function on_engine_response(message) {
    console.log('on_engine_response', message);
    if (config.engine === 'remote') {
        last_eval = Object.assign(last_eval, message);
        on_engine_evaluation(last_eval);
        on_engine_best_move(last_eval.bestmove, last_eval.threat, true);
        return;
    }

    if (message.includes('lowerbound') || message.includes('upperbound') || message.includes('currmove')) {
        return; // ignore these messages
    } else if (message.startsWith('bestmove')) {
        const arr = message.split(' ');
        const best = arr[1];
        const threat = arr[3];
        on_engine_best_move(best, threat, true);
    } else if (message.startsWith('info depth')) {
        const lineInfo = {};
        const tokens = message.split(' ').slice(1);
        for (let i = 0; i < tokens.length; i++) {
            const token = tokens[i];
            if (token === 'score') {
                lineInfo.rawScore = `${tokens[i + 1]} ${tokens[i + 2]}`;
                i += 2; // take 2 tokens
            } else if (token === 'pv') {
                lineInfo['move'] = tokens[i + 1];
                lineInfo[token] = tokens.slice(i + 1).join(' '); // take rest of tokens
                break;
            } else {
                const num = parseInt(tokens[i + 1]);
                lineInfo[token] = isNaN(num) ? tokens[i + 1] : num;
                i++; // take 1 token
            }
        }

        const scoreNumber = Number(lineInfo.rawScore.substring(lineInfo.rawScore.indexOf(' ') + 1));
        const scoreType = lineInfo.rawScore.includes('cp') ? 'score' : 'mate';
        lineInfo[scoreType] = (turn === 'w' ? 1 : -1) * scoreNumber;

        const pvIdx = (lineInfo.multipv - 1) || 0;
        last_eval.activeLines = Math.max(last_eval.activeLines, lineInfo.multipv);
        if (pvIdx === 0) {
            // continuously show the best move for each depth
            if (last_eval.lines[0] != null) {
                const arr = last_eval.lines[0].pv.split(' ');
                const best = arr[0];
                const threat = arr[1];
                on_engine_best_move(best, threat);
            }
            // reset lines
            last_eval.lines = new Array(config.multiple_lines);
            // trigger an evaluation update
            last_eval.lines[pvIdx] = lineInfo;
            on_engine_evaluation(last_eval);
        } else {
            last_eval.lines[pvIdx] = lineInfo;
        }
    }

    if (is_calculating) {
        prog++;
        let progMapping = 100 * (1 - Math.exp(-prog / 30));
        document.getElementById('progBar')?.setAttribute('value', `${Math.round(progMapping)}`);
    }
}

function on_new_pos(fen, startFen, moves) {
    console.log("on_new_pos", fen, startFen, moves);
    toggle_calculating(true);
    if (config.engine === 'remote') {
        if (moves) {
            request_remote_analysis(startFen, config.compute_time, moves).then(on_engine_response);
        } else {
            request_remote_analysis(fen, config.compute_time).then(on_engine_response);
        }
    } else {
        send_engine_uci('stop');
        if (moves) {
            send_engine_uci(`position fen ${startFen} moves ${moves}`);
        } else {
            send_engine_uci(`position fen ${fen}`);
        }
        send_engine_uci(`go movetime ${config.compute_time}`);
    }

    board.position(fen);
    clear_annotations();
    if (config.simon_says_mode) {
        const toplay = (turn === 'w') ? 'White' : 'Black';
        if (toplay.toLowerCase() !== board.orientation()) {
            draw_moves();
            request_console_log('Best Move: ' + last_eval.bestmove);
        }
    }
    last_eval = {fen, activeLines: 0, lines: new Array(config.multiple_lines)}; // new evaluation
}

function parse_position_from_response(txt) {
    if (!txt || typeof txt !== 'string') {
        console.warn('parse_position_from_response: invalid txt', txt);
        return {fen: '', startFen: '', moves: ''};
    }
    const prefixMap = {
        li: 'Game detected on Lichess.org',
        cc: 'Game detected on Chess.com',
        bt: 'Game detected on BlitzTactics.com'
    };

    function parse_position_from_moves(txt, startFen = null) {
        const directKey = (startFen) ? `${startFen}_${txt}` : txt;
        const directHit = fen_cache.get(directKey);
        if (directHit) { // reuse position
            console.log('DIRECT');
            turn = directHit.fen.charAt(directHit.fen.indexOf(' ') + 1);
            return directHit;
        }

        let record;
        const lastMoveRegex = /([a-zA-Z0-9\-+=#]+[*]+)$/;
        const indirectKey = directKey.replace(lastMoveRegex, '');
        const indirectHit = fen_cache.get(indirectKey);
        if (indirectHit) { // append newest move
            console.log('INDIRECT');
            const chess = new Chess(config.variant, indirectHit.fen);
            let move = txt.match(lastMoveRegex)[0].split('*****')[0];
            if (move.includes('=M')) {
                move = move.replace('=M', '=Q');
            }
            const moveReceipt = chess.move(move);
            turn = chess.turn();
            record = {fen: chess.fen(), startFen: indirectHit.startFen, moves: indirectHit.moves + ' ' + moveReceipt.lan}
        } else { // perform all moves
            console.log('FULL');
            const chess = new Chess(config.variant, startFen);
            const sans = txt.split('*****').slice(0, -1);
            let moves = '';
            for (let san of sans) {
                if (san.includes('=M')) {
                    san = san.replace('=M', '=Q');
                }
                const moveReceipt = chess.move(san);
                moves += moveReceipt.lan + ' ';
            }
            turn = chess.turn();
            record = {fen: chess.fen(), startFen: chess.startFen(), moves: moves.trim()};
        }

        fen_cache.set(directKey, record);
        return record;
    }

    function parse_position_from_pieces(txt) {
        const directHit = fen_cache.get(txt);
        if (directHit) { // reuse position
            console.log('DIRECT');
            turn = directHit.fen.charAt(directHit.fen.indexOf(' ') + 1);
            return directHit;
        }

        console.log('FULL');
        const chess = new Chess(config.variant);
        chess.clear(); // clear the board so we can place our pieces
        const [playerTurn, ...pieces] = txt.split('*****').slice(0, -1);
        for (const piece of pieces) {
            const attributes = piece.split('-');
            chess.put({type: attributes[1], color: attributes[0]}, attributes[2]);
        }
        chess.setTurn(playerTurn);
        turn = chess.turn();

        const record =  {fen: chess.fen()};
        fen_cache.set(txt, record);
        return record;
    }

    const metaTag = txt.substring(3, 8);
    const prefix = metaTag.substring(0, 2);
    document.getElementById('game-detection').innerText = prefixMap[prefix];
    txt = txt.substring(11);

    if (metaTag.includes('var')) {
        if (config.variant === 'fischerandom') {
            const puzTxt = txt.substring(0, txt.indexOf('&'));
            const fenTxt = txt.substring(txt.indexOf('&') + 6);
            const startFen = parse_position_from_pieces(puzTxt).fen.replace('-', 'KQkq');
            return parse_position_from_moves(fenTxt, startFen);
        }
        return parse_position_from_moves(txt);
    } else if (metaTag.includes('puz')) { // chess.com & blitztactics.com puzzle pages
        return parse_position_from_pieces(txt);
    } else { // chess.com and lichess.org pages
        return parse_position_from_moves(txt);
    }
}

function update_evaluation(eval_string) {
    if (eval_string != null && config.computer_evaluation) {
        document.getElementById('evaluation').innerHTML = eval_string;
    }
}

function update_best_move(line1, line2) {
    if (line1 != null) {
        document.getElementById('chess_line_1').innerHTML = line1;
    }
    if (line2 != null) {
        document.getElementById('chess_line_2').innerHTML = line2;
    }
}

// UI helpers
function toggle_calculating(on) {
    is_calculating = !!on;
    prog = 0;
    let progBar = document.getElementById('progBar');
    if (!progBar) {
        progBar = document.createElement('progress');
        progBar.id = 'progBar';
        progBar.max = 100;
        progBar.value = 0;
        progBar.style.width = '100%';
        const boardElem = document.getElementById('board');
        if (boardElem && boardElem.parentNode) boardElem.parentNode.insertBefore(progBar, boardElem.nextSibling);
    }
    progBar.style.display = is_calculating ? 'block' : 'none';
    if (!is_calculating) progBar.value = 0;
}

function clear_annotations() {
    const ma = document.getElementById('move-annotations');
    const ra = document.getElementById('response-annotations');
    if (ma) ma.innerHTML = '';
    if (ra) ra.innerHTML = '';
}

function draw_moves() {
    const ma = document.getElementById('move-annotations');
    if (!ma) return;
    ma.innerHTML = '';
    if (!last_eval || !last_eval.lines) return;
    for (let i = 0; i < last_eval.lines.length; i++) {
        const line = last_eval.lines[i];
        if (!line) continue;
        const div = document.createElement('div');
        div.className = 'mvline';
        div.innerText = line.pv || (line.move ? line.move : JSON.stringify(line));
        ma.appendChild(div);
    }
}

function draw_threat() {
    const ra = document.getElementById('response-annotations');
    if (!ra) return;
    ra.innerHTML = '';
    if (last_eval && last_eval.threat) {
        const d = document.createElement('div');
        d.innerText = `Threat: ${last_eval.threat}`;
        ra.appendChild(d);
    }
}

async function dispatch_click_event(x, y) {
    if (config.python_autoplay_backend) {
        await request_backend_click(x, y);
    } else {
        await request_debugger_click(x, y);
    }
}

async function request_debugger_click(x, y) {
    // Query active tab as a promise
    const tabs = await new Promise((resolve) => chrome.tabs.query({active: true, currentWindow: true}, resolve));
    if (!tabs || !tabs[0]) {
        console.error('No active tab found for debugger click');
        return;
    }
    const tabId = tabs[0].id;
    const debugee = {tabId: tabId};

    // Best-effort detach any existing debugger attached by this extension or a stale handle.
    await new Promise((resolve) => {
        try {
            chrome.debugger.detach(debugee, () => {
                // read lastError to avoid unchecked runtime.lastError warnings
                if (chrome.runtime.lastError) {
                    // ignore
                    // console.debug('debugger.detach (pre) warning:', chrome.runtime.lastError.message);
                }
                resolve();
            });
        } catch (e) { resolve(); }
    });

    // Try to attach debugger. If another debugger is already attached, chrome.runtime.lastError will be set.
    const attached = await new Promise((resolve) => {
        chrome.debugger.attach(debugee, '1.3', () => {
            if (chrome.runtime.lastError) {
                console.error('Debugger attach failed:', chrome.runtime.lastError.message);
                return resolve(false);
            }
            resolve(true);
        });
    });

    if (!attached) {
        // Inform user and abort gracefully
        console.error('Could not attach debugger to tab', tabId, '. Another debugger may be attached.');
        return;
    }

    try {
        await dispatch_mouse_event(debugee, 'Input.dispatchMouseEvent', {
            type: 'mousePressed',
            button: 'left',
            clickCount: 1,
            x: x,
            y: y,
        });
        await dispatch_mouse_event(debugee, 'Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            button: 'left',
            clickCount: 1,
            x: x,
            y: y,
        });
    } catch (err) {
        console.error('Error dispatching mouse events via debugger:', err);
    } finally {
        // Always attempt to detach our debugger to avoid leaving it attached.
        chrome.debugger.detach(debugee, () => {
            if (chrome.runtime.lastError) {
                console.warn('debugger.detach(final) warning:', chrome.runtime.lastError.message);
            }
        });
    }
}

async function dispatch_mouse_event(debugee, mouseEvent, mouseEventOpts) {
    return new Promise((resolve, reject) => {
        chrome.debugger.sendCommand(debugee, mouseEvent, mouseEventOpts, (result) => {
            if (chrome.runtime.lastError) {
                return reject(chrome.runtime.lastError);
            }
            resolve(result);
        });
    });
}

async function request_backend_click(x, y) {
    return call_backend(`http://localhost:8080/performClick`, {x: x, y: y});
}

async function request_backend_move(x0, y0, x1, y1) {
    return call_backend('http://localhost:8080/performMove', {x0: x0, y0: y0, x1: x1, y1: y1});
}

async function request_remote_configure(options) {
    return call_backend('http://localhost:9090/configure', options).then(res => res.json());
}

async function request_remote_analysis(fen, time, moves = null) {
    return call_backend('http://localhost:9090/analyse', {
        fen: fen,
        moves: moves,
        time: time,
    }).then(res => res.json());
}

async function call_backend(url, data) {
    return fetch(url, {
        method: 'POST',
        credentials: 'include',
        cache: 'no-cache',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(data)
    });
}

function promise_timeout(time) {
    return new Promise((resolve) => {
        setTimeout(() => resolve(time), time);
    });
}
