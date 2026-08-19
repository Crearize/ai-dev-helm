// lint fixture: secret-looking lines that must NOT be reported
const awsFromEnv = process.env.AWS_ACCESS_KEY_ID || 'AKIA0000000000000002';
const interpolated = `AKIA0000000000000003-${suffix}`;
const angleKey = '<AKIA0000000000000004>';
const password = 'changeme-please-now';
const awsDocs = 'AKIAIOSFODNN7EXAMPLE';
const pyStyle = "aws = os.environ.get('AWS', 'AKIA0000000000000005')";
