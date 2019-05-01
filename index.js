let mime = require('mime');
let fs = require('fs');
let pathm = require('path');

module.exports = {
    init: init,
};

/**
 * Initialize plugin
 * @param {object} pluginInterface The interface of picogw plugin
 */
function init(pluginInterface) {
    const pi = pluginInterface;

    // Static contents call
    pi.http.endpoint('get', '*', (req, res, next) => {
        let path = req.path;
        if (path.charAt(path.length-1)=='/') path += 'index.html';

        const pt = pathm.join(pathm.dirname(__filename), 'htdocs', path);
        fs.readFile(pt, (err, data)=>{
            if (err) {
                res.status(404).send('No such resource');
                return;
            }
            if (path==='/js/customize.js') {
                data = data.toString();
                data = data.split('__%%RSA_PUB_KEY%%__')
                    .join('"'+pi.crypt.getPubKey()+'"');
            }
            res.set('Content-Type', mime.getType(path)); // 'text/html; charset=UTF-8'
            res.status(200);

            res.send(data);
        });
    });
};
