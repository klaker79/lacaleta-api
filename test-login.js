const http = require('http');

const data = JSON.stringify({
    email: 'demo@lacaleta102.com',
    password: '123456'
});

const options = {
    hostname: 'localhost',
    port: 3001,
    path: '/api/auth/login',
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length
    }
};

const req = http.request(options, (res) => {
    let body = '';

    console.log(`Status Code: ${res.statusCode}`);

    res.on('data', (chunk) => {
        body += chunk;
    });

    res.on('end', () => {
        console.log('Response Body:', body);
        if (res.statusCode === 200 || res.statusCode === 201) {
            console.log('✅ LOGIN SUCCESSFUL (Backend is working)');
        } else {
            console.log('❌ LOGIN FAILED');
        }
    });
});

req.on('error', (error) => {
    console.error('Error:', error);
});

req.write(data);
req.end();
