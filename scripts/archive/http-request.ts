import https from 'https';
const url = 'https://zeoqbuuqkerllsmoxjxa.supabase.co/rest/v1/incoming_messages?select=count';
const key = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inplb3FidXVxa2VybGxzbW94anhhIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc0Mjg2MTM5NywiZXhwIjoyMDU4NDM3Mzk3fQ.U3W3W9yO4j-hFwS5suYMyGRRzI04-Dk3w_wl90HX7yI';

const req = https.request(url, {
    method: 'GET',
    headers: {
        'apikey': key,
        'Authorization': `Bearer ${key}`
    }
}, (res) => {
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => {
        console.log('Status:', res.statusCode);
        console.log('Body:', d);
    });
});
req.on('error', console.error);
req.end();
