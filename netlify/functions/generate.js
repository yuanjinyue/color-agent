const crypto = require('crypto');

function hmacSHA256(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

function makeSign(secretKey, accessKeyId, body, action) {
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

async function callVolc(AK, SK, action, bodyObj) {
  const body = JSON.stringify(bodyObj);
  const { datetime, authorization, bodyHash } = makeSign(SK, AK, body, action);
  const resp = await fetch(
    `https://visual.volcengineapi.com/?Action=${action}&Version=2022-08-31`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Host': 'visual.volcengineapi.com',
        'X-Date': datetime,
        'X-Content-Sha256': bodyHash,
        'Authorization': authorization,
      },
      body,
    }
  );
  return resp.json();
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

  const { action, prompt, width = 1024, height = 1024, seed = -1, ref_image_base64, task_id } = reqBody;

  try {
    // ── 查询任务结果 ──
    if (action === 'query') {
      if (!task_id) return { statusCode: 400, headers, body: JSON.stringify({ error: '缺少 task_id' }) };
      const qdata = await callVolc(AK, SK, 'CVSync2AsyncGetResult', { task_id });
      const status = qdata.data?.status || 'unknown';
      const urls = qdata.data?.image_urls || [];
      return { statusCode: 200, headers, body: JSON.stringify({ status, urls }) };
    }

    // ── 提交生图任务 ──
    if (!prompt) return { statusCode: 400, headers, body: JSON.stringify({ error: '缺少 prompt' }) };

    let data;
    if (ref_image_base64) {
      // 图生图：使用图片4.0接口，支持参考图编辑
      const base64 = ref_image_base64.replace(/^data:image\/[a-z+]+;base64,/, '');
      data = await callVolc(AK, SK, 'CVSync2AsyncSubmitTask', {
        req_key: 'jimeng_i2i_v30',
        prompt,
        binary_data_base64: [base64],
        seed,
        width,
        height,
        return_url: true,
        logo_info: { add_logo: false },
      });
    } else {
      // 文生图：使用文生图3.0
      data = await callVolc(AK, SK, 'CVSync2AsyncSubmitTask', {
        req_key: 'jimeng_t2i_v30',
        prompt,
        seed,
        width,
        height,
        return_url: true,
        logo_info: { add_logo: false },
      });
    }

    if (data.code !== 10000) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: data.message || '提交失败', code: data.code })
      };
    }

    const taskId = data.data?.task_id;
    if (!taskId) return { statusCode: 500, headers, body: JSON.stringify({ error: '未获取到 task_id' }) };
    return { statusCode: 200, headers, body: JSON.stringify({ task_id: taskId }) };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
