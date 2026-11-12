const fs = require('fs');
const path = require('path');

async function testUpload() {
  const assetsDir = path.join(__dirname, 'test-assets');
  const img1 = path.join(assetsDir, 'news_subject1.jpg');
  const img2 = path.join(assetsDir, 'news_subject2.jpg');
  const rx = path.join(assetsDir, 'news_reaction.jpg');

  const formData = new FormData();
  formData.append('subjectImages', new Blob([fs.readFileSync(img1)]), 'chiranjeevi.jpg');
  formData.append('subjectImages', new Blob([fs.readFileSync(img2)]), 'akhil.jpg');
  formData.append('reactionImage', new Blob([fs.readFileSync(rx)]), 'rao_ramesh.jpg');

  const payload = {
    content: {
      topic: 'Multipart Upload Test',
      statement: 'TESTING MULTIPART FORM DATA UPLOAD ENDPOINT DIRECTLY FROM CLIENT TO NESTJS BACKEND.\n- TEST VERIFIED',
      reactionContext: '* MULTIPART TEST SUCCESSFUL',
      punchline: 'సూపర్ సక్సెస్ అయింది బ్రో!'
    },
    layout: {
      memeType: 'trending_news',
      arrangement: 'side_by_side'
    },
    design: {
      primaryTextColor: '#FFE500',
      secondaryTextColor: '#FFFFFF',
      outlineThickness: 8
    },
    subjectLabels: ['Chiru', 'Akhil']
  };

  formData.append('payload', JSON.stringify(payload));

  console.log('Sending multipart POST request to http://localhost:3000/api/memes/upload-and-generate...');
  const res = await fetch('http://localhost:3000/api/memes/upload-and-generate', {
    method: 'POST',
    body: formData
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error('Upload failed:', res.status, errText);
    return;
  }

  const result = await res.json();
  console.log('Upload and Generation SUCCESS!');
  console.log('ID:', result.id);
  console.log('PNG URL:', result.outputUrls.png);
  console.log('JPEG URL:', result.outputUrls.jpeg);
}

testUpload().catch(console.error);

