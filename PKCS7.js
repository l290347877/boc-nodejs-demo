const forge = require('node-forge');
const fs = require('fs');
class PKCS7 {

  static sign(data) {
    const pfx = fs.readFileSync('./app/common/prod.pfx');
    const pfxAsn1 = forge.asn1.fromDer(forge.util.decode64(pfx.toString('base64')));
    const pfxObj = forge.pkcs12.pkcs12FromAsn1(pfxAsn1, 'xxxxxx'); // 密码

    const bags = pfxObj.getBags({bagType: forge.pki.oids.pkcs8ShroudedKeyBag});
    const bag = bags[forge.pki.oids.pkcs8ShroudedKeyBag][0];
    const privateKey = bag.key;
    
    const certificate = pfxObj.getBags({bagType: forge.pki.oids.certBag})[forge.pki.oids.certBag][0].cert;

    const p7 = forge.pkcs7.createSignedData();
    p7.content = forge.util.createBuffer(data, 'utf8');
    p7.addCertificate(certificate);
    p7.addSigner({
      key: privateKey,
      certificate: certificate,
      digestAlgorithm: forge.pki.oids.sha256
    });
    // p7.detached = true; // 设置签名为 detached
    p7.sign({detached: true});

    const p7Der = forge.asn1.toDer(p7.toAsn1()).getBytes();
    return forge.util.encode64(p7Der);
  }

  static verify(signature, data, ctx) {
    if (!signature) return false
    const pemFile = './app/common/prod.pem';
    if (!fs.existsSync(pemFile)) {
      const certDer = fs.readFileSync('./app/common/prod.cer');
      const certAsn1 = forge.asn1.fromDer(certDer.toString('binary'));
      const cert = forge.pki.certificateFromAsn1(certAsn1);
      const certPem = forge.pki.certificateToPem(cert);
      // 将证书写入一个临时的 PEM 文件
      fs.writeFileSync(pemFile, certPem);
    }
    const certificatePem = fs.readFileSync(pemFile, 'utf8'); // -----BEGIN CERTIFICATE-----...-----END CERTIFICATE-----
    // signature 是单行的 Base64 编码的 PKCS#7 签名
    const pkcs7Pem = '-----BEGIN PKCS7-----\r\n' + signature + '\r\n-----END PKCS7-----';
    let p7;
    try { 
      p7 = forge.pkcs7.messageFromPem(pkcs7Pem);
    } catch (e) {
      ctx.logger.error('pkcs7Pem try error');
      return false;
    }

    // Convert PKCS#7 signature to CMS signature
    // 临时验证代码，只通过了测试，未经验证生产
    const cmsPem = forge.pki.certificateToPem(p7.certificates[0]);
    if (certificatePem !== cmsPem) {
      ctx.logger.error('Certificate is not the same as the one used to sign the data');
      return false;
    }
    return true;

  }
}

module.exports = PKCS7;
