const WS_SUBPROTOCOL = 'picogw';

let WebSocketServer = require('websocket').server;
let express = require('express');
const bodyParser = require('body-parser');
let mime = require('mime');
let fs = require('fs');
let pathm = require('path');

exports.init = function(pluginInterface) {
    const pi = pluginInterface;
    const localStorage = pi.localStorage;
    const log = pi.log;

    // TODO: We will replace it with the command line argument function in the future
    let SERVER_PORT = pi.cmd_opts.get('port') ||
        localStorage.getItem('PORT_NUM') || 8080;

    let http = express();
    http.use(bodyParser.urlencoded({extended: true}));
    http.use(bodyParser.json());
    http.use(function(e, req, res, next) {
        res.jsonp(e); // Catch json error
    });

    let server;

    const startServer = () => {
        if (server != undefined) server.close();

        server = http.listen(SERVER_PORT, function() {
            log('Web server is waiting on port '+SERVER_PORT+'.');
        });

        // REST API call
        http.all(`/v*/*`, function(req, res, next) {
            // for( var e in req ){if( typeof req[e] == 'string') log(e+':'+req[e]);}
            // var caller_ip = req.ip ;
            let args = req.body;
            // Overwrite args in body with GET parameters
            if (req.originalUrl.indexOf('?') >= 0) {
                const pos = req.originalUrl.indexOf('?')+1;
                req.originalUrl.slice(pos).split('&').forEach((eq)=>{
                    let terms = eq.split('=');
                    if (terms[0] === 'callback' ||
                        terms[0] === 'jsoncallback') {
                        return;
                    }
                    if (terms.length === 1) {
                        args.value = decodeURIComponent(terms[0]);
                    } else {
                        args[terms[0]] = decodeURIComponent(terms[1]);
                    }
                });
            }

            // 多分常に文字列。JSONオブジェクトに変換できるときはオブジェクトに、数値に変換できる
            // 時は数値に、それ以外はそのまま文字列として、プラグインに与える。
            for (let k in args) {
                if (typeof args[k] == 'string') {
                    try {
                        args[k] = JSON.parse(args[k]);
                    } catch (e) {
                        if (isFinite(parseInt(args[k]))) {
                            args[k] = parseInt(args[k]);
                        }
                    }
                }
            }
            pi.client.callProc({method: req.method, path: req.path, args: args})
                .then((re)=>{
                    res.jsonp(re);
                }).catch((e)=>{
                    next();
                    /* console.error*/
                });
        });

        // Static contents call
        http.get('*', (req, res, next) => {
            let path = req.path;
            if (path.charAt(path.length-1)=='/') path += 'index.html';

            const pt = pathm.join(pathm.dirname(__filename), 'htdocs', path);
            fs.readFile(pt, (err, data)=>{
                if (err) {
                    res.status(404).send('No such resource');
                    return;
                }
                if (path==='/index.html') {
                    data = data.toString();
                    data = data.split('__%%RSA_PUB_KEY%%__')
                        .join('"'+pi.crypt.getPubKey()+'"');
                    data = data.split('__%%ADDITIONAL_LICENSES%%__').join('""');
                }
                res.set('Content-Type', mime.getType(path)); // 'text/html; charset=UTF-8'
                res.status(200);

                res.send(data);
            });
        });

        let wsServer = new WebSocketServer({
            httpServer: server,
            autoAcceptConnections: false,
        });

        const originIsAllowed = (origin) => {
            // put logic here to detect whether the specified origin is allowed.
            return true;
        };

        wsServer.on('request', function(request) {
            if (!originIsAllowed(request.origin)) {
                // Make sure we only accept requests from an allowed origin
                request.reject();
                log((new Date()) + ' Connection from origin ' + request.origin + ' rejected.'); // eslint-disable-line max-len
                return;
            }

            let connection;
            try {
                connection = request.accept(WS_SUBPROTOCOL, request.origin);
            } catch (e) {
                console.error(e);
                return;
            }

            // log((new Date()) + ' Connection accepted.');
            let subscribeFuncs = {};
            connection.on('message', function(message) {
                if (message.type === 'utf8') {
                    log('Received Message: ' + message.utf8Data);
                    let req;
                    try {
                        req = JSON.parse(message.utf8Data);
                        if (req.method.toUpperCase() == 'SUB') {
                            let cbfunc = function(re) {
                                connection.sendUTF(JSON.stringify(re));
                            };
                            if (subscribeFuncs[req.path] == undefined) {
                                pi.client.subscribe(req.path, cbfunc);
                                subscribeFuncs[req.path] = cbfunc;
                            }
                            connection.sendUTF(JSON.stringify(
                                {success: true, tid: req.tid}));
                        } else if (req.method.toUpperCase() == 'UNSUB') {
                            if (subscribeFuncs[req.path] != undefined) {
                                pi.client.unsubscribe(
                                    req.path, subscribeFuncs[req.path]);
                                delete subscribeFuncs[req.path];
                            }
                            connection.sendUTF(JSON.stringify(
                                {success: true, tid: req.tid}));
                        } else {
                            pi.client.callProc(req).then((re)=>{
                                re.tid = req.tid;
                                connection.sendUTF(JSON.stringify(re)+'\n');
                            }).catch((e)=>{
                                e.tid = req.tid;
                                connection.sendUTF(JSON.stringify(e)+'\n');
                            });
                        }
                    } catch (e) {
                        log('Error in receiving websocket message');
                        log(JSON.stringify(e));
                        log(e);
                    }
                } else if (message.type === 'binary') {
                    log('Received Binary Message of ' + message.binaryData.length + ' bytes. Ignore.'); // eslint-disable-line max-len
                    // connection.sendBytes(message.binaryData);
                }
            });
            connection.on('close', function(reasonCode, description) {
                // log((new Date()) + ' Peer ' + connection.remoteAddress + ' disconnected.');
                for (const path of Object.keys(subscribeFuncs)) {
                    pi.client.unsubscribe(path, subscribeFuncs[path]);
                }
                subscribeFuncs = {};
            });
        });
    };

    startServer();

    pi.client.subscribe('/v1/admin/client_settings', (re)=>{
        let cs = re['/v1/admin/client_settings'];
        if (cs.port != null && cs.port != SERVER_PORT) {
            localStorage.setItem('PORT_NUM', cs.port);
            SERVER_PORT = cs.port;
            startServer();
        }
    });
};
