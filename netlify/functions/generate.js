const crypto = require('crypto');

function hmacSHA256(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

function sign(secretKey, accessKeyId, body) {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, '');
  const datetime = now.toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
  const service = 'cv';
  const region = 'cn-north-1';
  const host = 'visual.volcengineapi.com';
  const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
  const canonicalHeaders = `content-type:application/json\nhost:${host}\nx-content-sha256:${bodyHash}\nx-date:${datetime}\n`;
  const signedHeaders = 'content-type;host;x-content-sha256;x-date';
  const canonicalRequest = ['POST', '/', 'Action=CVSync2AsyncSubmitTask&Version=2022-08-31', canonicalHeaders, signedHeaders, bodyHash].join('\n');
  const credentialScope = `${date}/${region}/${service}/request`;
  const stringToSign = ['HMAC-SHA256', datetime, credentialScope, crypto.createHash('sha256').update(canonicalRequest).digest('hex')].join('\n');
  const signingKey = hmacSHA256(hmacSHA256(hmacSHA256(hmacSHA256(secretKey, date), region), service), 'request');
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  const authorization = `HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { datetime, authorization, bodyHash };
}

function signQuery(secretKey, accessKeyId, body, action) {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, '');
  const datetime = now.toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
  const service = 'cv';
  const region = 'cn-north-1';
  const host = 'visual.volcengineapi.com';
  const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
  const canonicalHeaders = `content-type:application/json\nhost:${host}\nx-content-sha256:${bodyHash}\nx-date:${datetime}\n`;
  const signedHeaders = 'content-type;host;x-content-sha256;x-date';
  const canonicalRequest = ['POST', '/', `Action=${action}&Version=2022-08-31`, canonicalHeaders, signedHeaders, bodyHash].join('\n');
  const credentialScope = `${date}/${region}/${service}/request`;
  const stringToSign = ['HMAC-SHA256', datetime, credentialScope, crypto.createHash('sha256').update(canonicalRequest).digest('hex')].join('\n');
  const signingKey = hmacSHA256(hmacSHA256(hmacSHA256(hmacSHA256(secretKey, date), region), service), 'request');
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  const authorization = `HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { datetime, authorization, bodyHash };
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  const AK = process.env.VOLC_ACCESS_KEY;
  const SK = process.env.VOLC_SECRET_KEY;
  if (!AK || !SK) return { statusCode: 500, headers, body: JSON.stringify({ error: '服务器未配置 API 密钥' }) };

  let reqBody;
  try { reqBody = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: '请求格式错误' }) }; }

  const { prompt, width = 1024, height = 1024, seed = -1 } = reqBody;
  if (!prompt) return { statusCode: 400, headers, body: JSON.stringify({ error: '缺少 prompt' }) };

  // 使用 jimeng_t2i_v30 — 即梦文生图3.0 正式 req_key
  const volcBody = JSON.stringify({
    req_key: 'jimeng_t2i_v30',
    prompt,
    seed,
    width,
    height,
    return_url: true,
    logo_info: { add_logo: false },
  });

  const { datetime, authorization, bodyHash } = sign(SK, AK, volcBody);

  try {
    const resp = await fetch(
      'https://visual.volcengineapi.com/?Action=CVSync2AsyncSubmitTask&Version=2022-08-31',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Host': 'visual.volcengineapi.com',
          'X-Date': datetime,
          'X-Content-Sha256': bodyHash,
          'Authorization': authorization,
        },
        body: volcBody,
      }
    );

    const data = await resp.json();

    if (data.code !== 10000) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: data.message || '提交任务失败', code: data.code }) };
    }

    const taskId = data.data?.task_id;
    if (!taskId) return { statusCode: 500, headers, body: JSON.stringify({ error: '未获取到 task_id' }) };

    // 轮询结果，最多等 60 秒
    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 1500));

      const queryBody = JSON.stringify({ task_id: taskId });
      const { datetime: qdt, authorization: qauth, bodyHash: qhash } = signQuery(SK, AK, queryBody, 'CVSync2AsyncGetResult');

      const queryResp = await fetch(
        'https://visual.volcengineapi.com/?Action=CVSync2AsyncGetResult&Version=2022-08-31',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Host': 'visual.volcengineapi.com',
            'X-Date': qdt,
            'X-Content-Sha256': qhash,
            'Authorization': qauth,
          },
          body: queryBody,
        }
      );

      const qdata = await queryResp.json();

      if (qdata.data?.status === 'done') {
        const urls = qdata.data?.image_urls || qdata.data?.binary_data_base64 || [];
        return { statusCode: 200, headers, body: JSON.stringify({ success: true, urls }) };
      }
      if (qdata.data?.status === 'failed') {
        return { statusCode: 500, headers, body: JSON.stringify({ error: '生图任务失败', detail: qdata.data }) };
      }
    }

    return { statusCode: 408, headers, body: JSON.stringify({ error: '生图超时，请重试' }) };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
