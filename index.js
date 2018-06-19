'use strict';

var http = require('http');
var https = require('https');
var url = require('url');

function debug() {
  if (module.exports.debug) {
    console.log.apply(console, arguments);
  }
}

function mergeOrDelete(defaults, updates) {
  Object.keys(defaults).forEach(function (key) {
    if (!(key in updates)) {
      updates[key] = defaults[key];
      return;
    }

    // neither accept the prior default nor define an explicit value
    // CRDT probs...
    if ('undefined' === typeof updates[key]) {
      delete updates[key];
    } else if ('object' === typeof defaults[key] && 'object' === typeof updates[key]) {
      updates[key] = mergeOrDelete(defaults[key], updates[key]);
    }
  });

  return updates;
}

function toJSONifier(keys) {

  return function () {
    var obj = {};
    var me = this;

    keys.forEach(function (key) {
      if (me[key] && 'function' === typeof me[key].toJSON) {
        obj[key] = me[key].toJSON();
      } else {
        obj[key] = me[key];
      }
    });

    return obj;
  };
}

function setDefaults(defs) {
  defs = defs || {};

  function requestLiteHelper(opts, cb) {
    debug("\n[request-lite] processed options:");
    debug(opts);

    function onResponse(resp) {
      var followRedirect;

      Object.keys(defs).forEach(function (key) {
        if (key in opts && 'undefined' !== typeof opts[key]) {
          return;
        }
        opts[key] = defs[key];
      });
      followRedirect = opts.followRedirect;

      resp.toJSON = toJSONifier([ 'statusCode', 'body', 'headers', 'request' ]);

      resp.request = req;
      resp.request.uri = url.parse(opts.url);
      //resp.request.method = opts.method;
      resp.request.headers = opts.headers;
      resp.request.toJSON = toJSONifier([ 'uri', 'method', 'headers' ]);

      if (followRedirect && resp.headers.location && -1 !== [ 301, 302 ].indexOf(resp.statusCode)) {
        debug('Following redirect: ' + resp.headers.location);
        if ('GET' !== opts.method && !opts.followAllRedirects) {
          followRedirect = false;
        }
        if (opts._redirectCount >= opts.maxRedirects) {
          followRedirect = false;
        }
        if ('function' === opts.followRedirect) {
          if (!opts.followRedirect(resp)) {
            followRedirect = false;
          }
        }
        if (followRedirect) {
          if (!opts.followOriginalHttpMethod) {
            opts.method = 'GET';
            opts.body = null;
          }
          if (opts.removeRefererHeader && opts.headers) {
            delete opts.headers.referer;
          }
          opts.url = resp.headers.location;
          opts.uri = url.parse(opts.url);
          return requestLiteHelper(opts, cb);
        }
      }
      if (null === opts.encoding) {
        resp._body = [];
      } else {
        resp.body = '';
      }
      resp._bodyLength = 0;
      resp.on('data', function (chunk) {
        if ('string' === typeof resp.body) {
          resp.body += chunk.toString(opts.encoding);
        } else {
          resp._body.push(chunk);
          resp._bodyLength += chunk.length;
        }
      });
      resp.on('end', function () {
        if ('string' !== typeof resp.body) {
          if (1 === resp._body.length) {
            resp.body = resp._body[0];
          } else {
            resp.body = Buffer.concat(resp._body, resp._bodyLength);
          }
          resp._body = null;
        }
        if (opts.json && 'string' === typeof resp.body) {
          // TODO I would parse based on Content-Type
          // but request.js doesn't do that.
          try {
            resp.body = JSON.parse(resp.body);
          } catch(e) {
            // ignore
          }
        }

        debug("\n[request-lite] resp.toJSON():");
        debug(resp.toJSON());
        cb(null, resp, resp.body);
      });
    }

    var req;
    var finalOpts = {};
    var _body;

    if (opts.body) {
      if (true === opts.json) {
        _body = JSON.stringify(opts.body);
      } else {
        _body = opts.body;
      }
    } else if (opts.json && true !== opts.json) {
      _body = JSON.stringify(opts.json);
    }
    if ('string' === typeof _body) {
      _body = Buffer.from(_body);
    }

    Object.keys(opts.uri).forEach(function (key) {
      finalOpts[key] = opts.uri[key];
    });
    finalOpts.method = opts.method;
    finalOpts.headers = opts.headers;
    if (_body) {
      // Most APIs expect (or require) Content-Length except in the case of multipart uploads
      // chunked is generally only well-supported downstream
      //finalOpts.headers['Content-Length'] = _body.byteLength || _body.length;
    }

    // TODO support unix sockets
    if ('https:' === finalOpts.protocol) {
      // https://nodejs.org/api/https.html#https_https_request_options_callback
      debug("\n[request-lite] https.request(opts):");
      debug(finalOpts);
      req = https.request(finalOpts, onResponse);
    } else if ('http:' === finalOpts.protocol) {
      // https://nodejs.org/api/http.html#http_http_request_options_callback
      debug("\n[request-lite] http.request(opts):");
      debug(finalOpts);
      req = http.request(finalOpts, onResponse);
    } else {
      throw new Error("unknown protocol: '" + opts.uri.protocol + "'");
    }

    req.on('error', function (e) {
      cb(e);
    });

    if (_body) {
      debug("\n[request-lite] body");
      debug(_body);
      // used for chunked encoding
      //req.write(_body);
      // used for known content-length
      req.end(_body);
    } else {
      req.end();
    }
  }

  function requestLite(opts, cb) {
    debug("\n[request-lite] received options:");
    debug(opts);
    var reqOpts = {};
    // request.js behavior:
    // encoding: null + json ? unknown
    // json => attempt to parse, fail silently
    // encoding => buffer.toString(encoding)
    // null === encoding => Buffer.concat(buffers)
    if ('string' === typeof opts) {
      opts = { url: opts };
    }
    if ('string' === typeof opts.url || 'string' === typeof opts.uri) {
      if ('string' === typeof opts.url) {
        reqOpts.url = opts.url;
        reqOpts.uri = url.parse(opts.url);
      } else if ('string' === typeof opts.uri) {
        reqOpts.url = opts.uri;
        reqOpts.uri = url.parse(opts.uri);
      }
    } else {
      if ('object' === typeof opts.uri) {
        reqOpts.url = url.format(opts.uri);
        reqOpts.uri = opts.uri;
        //reqOpts.uri = url.parse(reqOpts.uri);
      } else if ('object' === typeof opts.url) {
        reqOpts.url = url.format(opts.url);
        reqOpts.uri = opts.url;
        //reqOpts.uri = url.parse(reqOpts.url);
      }
    }
    reqOpts.method = (opts.method || 'GET').toUpperCase();
    reqOpts.headers = opts.headers || {};
    if ((true === reqOpts.json && reqOpts.body) || reqOpts.json) {
      reqOpts.headers['Content-Type'] = 'application/json';
    }

    module.exports._keys.forEach(function (key) {
      if (key in opts && 'undefined' !== typeof opts[key]) {
        reqOpts[key] = opts[key];
      } else if (key in defs) {
        reqOpts[key] = defs[key];
      }
    });

    return requestLiteHelper(reqOpts, cb);
  }

  requestLite.defaults = function (_defs) {
    _defs = mergeOrDelete(defs, _defs);
    return setDefaults(_defs);
  };
  [ 'get', 'put', 'post', 'patch', 'delete', 'head', 'options' ].forEach(function (method) {
    requestLite[method] = function (obj) {
      if ('string' === typeof obj) {
        obj = { url: obj };
      }
      obj.method = method.toUpperCase();
      requestLite(obj);
    };
  });
  requestLite.del = requestLite.delete;

  return requestLite;
}

var _defaults = {
  sendImmediately: true
, method: 'GET'
, headers: {}
, useQuerystring: false
, followRedirect: true
, followAllRedirects: false
, followOriginalHttpMethod: false
, maxRedirects: 10
, removeRefererHeader: false
//, encoding: undefined
, gzip: false
//, body: undefined
//, json: undefined
};
module.exports = setDefaults(_defaults);

module.exports._keys = Object.keys(_defaults).concat([
  'encoding'
, 'body'
, 'json'
]);
module.exports.debug = (-1 !== (process.env.NODE_DEBUG||'').split(/\s+/g).indexOf('request-lite'));

debug("DEBUG ON for request-lite");
