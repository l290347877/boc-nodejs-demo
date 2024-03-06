'use strict';
const dayjs = require('dayjs');
const xmlbuilder = require('xmlbuilder');
const xml2js = require('xml2js');
const _ = require('lodash');
const PKCS7 = require('./PKCS7');

export class BocDemo {
  getBankConfig() {
    return {
      MerId: '104360000000000', // 中国银行的商户号 AN15
      MerSubId: '', // 二级商户代码
      MerSubName: '', // 子商户名称
      TermId: '36000000', // 中国银行的商户所用终端号 AN8
      BussId: 'JHZF00000000', // 定长12位，业务编号，由HHAP系统为签约商户所分配的编号，一个编号下可能有多个商户号 AN12
      paymentApiUrl: 'https://xxxx.xxxx.boc.cn/merspay',
    }
  }
  // 查询订单是否已支付，如果已支付则更新订单状态

  async getPaymentOrderComplete(tuitionBillOrder) {
    const { MerId, TermId, paymentApiUrl } = this.getBankConfig();
    const { jianghuKnex } = this.app;
    const traceNo = await this.getNextTraceNo();
    const xml = await this.requestBody({
      IP: this.ctx.ip,
      TranId: '203003'
    }, {
      MerId, // 中国银行商户号
      TermId, // 8位终端号
      PayLs: TermId + dayjs().format('YYYYMMDDHHmmss') + traceNo, // 20位支付流水号
      OldTranId: '203002', // 订单描述
      QrCode: tuitionBillOrder.bocQrCode, // 二维码
      OldTranAmt: Math.round(tuitionBillOrder.amount * 100).toString().padStart(12, '0'), // 12位交易金额，单位分
      OldCcyCode: '156', // 国标 GB2659-94，156-人民币
    });
    await jianghuKnex('tuition_bill_order').where({ id: tuitionBillOrder.id }).update({ retryCount: tuitionBillOrder.retryCount + 1 });
    try {
      const msgBody = await this.sendRequest(paymentApiUrl, xml, '203003');
      if (msgBody.OldRespCode === '000000' && msgBody.OldRespMsg === '交易成功') {
        await jianghuKnex('tuition_bill_order').where({ tuitionOrderId: tuitionBillOrder.tuitionOrderId }).jhUpdate({paymentStatus: '已支付'});
      }
      return msgBody;
    } catch (error) {
      throw Error(error.message);
    }
  }
  // 获取支付二维码链接
  async getWxRedirectUrl() {
    const { ctx, app } = this;
    const { jianghuKnex } = app;
    const { TermId } = this.getBankConfig();
    const { billId = '' } = this.ctx.request.body.appData.actionData;
    // 1. todo 商户订单

    // 2. 查询最大的 traceNo 
    const traceNo = await this.getNextTraceNo(); // 6位请求编号 000001-999999 循环，需要用户存储请求log才能保证循环唯一
    // 3. 添加 tuition_bill_order 待支付订单
    const tuitionOrderId = this.generateOrderNumber();
    const PayLs = TermId + dayjs().format('YYYYMMDDHHmmss') + traceNo;
    // const amount = 0.03;
    // 4. 调用银行接口获取支付二维码链接
    const bocQrCode = await this.getBocQrCodeUrl({
      PayLs,
      TranAmt: bill.totalPaymentOutstanding,
      // TranAmt: amount,
      MerOrderNo: tuitionOrderId,
    }, bill.studentId);

    return bocQrCode;
  }
  generateOrderNumber() {
    // 使用 dayjs 获取当前日期和时间
    const date = dayjs().format('YYYYMMDDHHmmss');

    // 使用 lodash 生成一个 1000 到 9999 之间的随机数
    const randomNumber = _.random(1000, 9999);

    // 将日期和随机数拼接成订单号
    const orderNumber = `${date}${randomNumber}`;

    return orderNumber;
  }
  async getBocQrCodeUrl({PayLs, MerOrderNo, TranAmt}, studentId) {
    const { MerId, TermId, MerSubId = '', MerSubName = '', CallbackUrl, paymentApiUrl  } = this.getBankConfig();
    let xml = await this.requestBody({
      IP: this.ctx.ip,
      TranId: '203001'
    }, {
      MerId, // 中国银行商户号
      TermId, // 8位终端号
      PayLs, // 20位支付流水号
      TranAmt: Math.round(TranAmt * 100).toString().padStart(12, '0'), // 12位交易金额，单位分
      CcyCode: '156', // 国标 GB2659-94，156-人民币
      // 二维码流水号，应是账单学生唯一， 生成规则： TermId（8位）+交易日期（8位）+交易时间（6位）+序号（6位TraceNo）
      MerSubId, // 15位子商户号
      MerSubName, // 子商户名称
      OrderDesc: '缴费', // 订单描述
      MerOrderNo, // 12-32外部商户订单号
      QrValidTime: '600', // 10位二维码有效时间
      // url encode encodeURIComponent
      CallbackUrl: 'http://175.24.191.83:8026/notice/page/noticeTemplate/paymentDetail?studentId=' + studentId, // 回调地址
      QrDesData: '', // 二维码附加数据
      DeviceType: '11', // 设备类型
      // ip: '', // 客户端IP
    });
    try {
      const msgBody = await this.sendRequest(paymentApiUrl, xml, '203001');
      return msgBody.QrCode;
    } catch (error) {
      throw Error(error.message);
    }
  }
  async responseFormat(xml) {
    // 判断是否是xml
    if (!xml.startsWith('<')) {
      return JSON.parse(xml);
    }
    const [xmlStr, sign] = xml.split('\n');
    if (!sign) {
      throw new Error('100001');
    }
    await this.bodyVerify(xml);
    // PKCS7.verify(sign.match(/{S:(.*)}/)[1], xmlStr.match(/<root>.*<\/root>/)[0]);
    const {root: {MsgBody, MsgHeader, RespCode, RespMsg}} = await xml2js.parseStringPromise(xmlStr, {explicitArray: false, ignoreAttrs: true});
    return {msgBody: MsgBody, msgHeader: MsgHeader, respCode: RespCode, respMsg: RespMsg};
  }
  async bodyVerify(xml) {
    const [xmlStr, sign] = xml.split('\n');
    if (!sign) {
      throw new Error('100001');
    }
    const signature = sign.match(/{S:(.*)}/)[1];
    if (signature) {
      const validate = PKCS7.verify(sign.match(/{S:(.*)}/)[1], xmlStr.match(/<root>.*<\/root>/)[0], this.ctx);
      if (!validate) {
        this.ctx.logger.error(xml);
        throw new Error('100001');
      }
    }
  }
  async sendRequest(url, xml, TranId) {
    const response = await axios({
      method: 'post',
      url: url,
      data: xml,
      timeout: 60000,
      headers: {
        'Content-Type': 'text/xml',
        'Content-Length': xml.length,
        'TranId': TranId
      }
    })
    const { msgHeader, msgBody } = await this.responseFormat(response.data);
    if (msgBody.RespCode != '000000') {
      throw new Error(msgBody.RespMsg);
    }
    return msgBody;
  }
  
  /**
   * 构建请求报文
   * @param {TranId, } msgHeader 
   * @param {*} msgBody 
   * @returns 
   */
  async requestBody(msgHeader, msgBody) {
    /**
     * 同步请求-交易编码
     * 203001	申请动态码
     * 203002	正扫消费
     * 203003	支付结果查询
     * 203004	退货
     * 203007	退货结果查询
     * 203008 	关闭订单
     * 203009	电子支付申码
     */
    const bankConfig = this.getBankConfig();
    const xml = xmlbuilder.create('root', { version: '1.0', encoding: 'UTF-8' });

    const header = xml.ele('MsgHeader');
    // msgHeader 共有部分
    header.ele('MsgVer', '1000');
    header.ele('InDate', dayjs().format('YYYYMMDD'));
    header.ele('InTime', dayjs().format('HHmmss'));
    header.ele('BussId', bankConfig.BussId); // AN20: 20位商户号
    header.ele('MerTp', '01'); // 01-普通商户 02-平台商户
    header.ele('Drctn', '11'); // 11-请求 12-应答
    header.ele('EncKey', '');
    header.ele('PubKeyId', ''); // 公钥标识
    header.ele('SysNo', ''); // 前端系统标识


    for (const key in msgHeader) {
        header.ele(key, msgHeader[key]);
    }

    var body = xml.ele('MsgBody');
    for (var key in msgBody) {
        body.ele(key, msgBody[key]);
    }
    const str = xml.end();
    const insert = await this.app.jianghuKnex('boc_request_log').insert({
      traceNo: msgBody.PayLs.slice(-6),
      bocPayLs: msgBody.PayLs,
      bocRequest: JSON.stringify(msgBody),
      tranId: msgHeader.TranId,
    });
    this.requestLogId = insert[0];
    return str + '\r\n' + '{S:' + PKCS7.sign(str.match(/<root>.*<\/root>/)[0]) + '}'
  }

  xmlError(Error) {
    const bankConfig = this.getBankConfig();
    const xml = xmlbuilder.create('root', { version: '1.0', encoding: 'UTF-8' });
    const header = xml.ele('MsgHeader', );
    // msgHeader 共有部分
    header.ele('MsgVer', '1000');
    header.ele('InDate', dayjs().format('YYYYMMDD'));
    header.ele('InTime', dayjs().format('HHmmss'));
    header.ele('TranId', '203101'); // 交易编码 - 
    header.ele('BussId', bankConfig.BussId); // AN20: 20位商户号
    header.ele('MerTp', '01'); // 01-普通商户 02-平台商户
    header.ele('Drctn', '12'); // 11-请求 12-应答
    header.ele('EncKey', '');
    header.ele('PubKeyId', ''); // 公钥标识
    header.ele('SysNo', ''); // 前端系统标识

    const body = xml.ele('MsgBody', );
    body.ele('RespCode', Error.errorCode || '999999');
    body.ele('RespMsg', Error.errorReason || Error.message);
    const xmlStr = xml.end();
    return xmlStr + '\r\n' + '{S:' + PKCS7.sign(xmlStr.match(/<root>.*<\/root>/)[0]) + '}';
  }
  xmlSuccess(msgBody) {
    const bankConfig = this.getBankConfig();
    const xml = xmlbuilder.create('root', { version: '1.0', encoding: 'UTF-8' });

    const header = xml.ele('MsgHeader', );
    // msgHeader 共有部分
    header.ele('MsgVer', '1000');
    header.ele('InDate', dayjs().format('YYYYMMDD'));
    header.ele('InTime', dayjs().format('HHmmss'));
    header.ele('TranId', '203101'); // 交易编码 - 
    header.ele('BussId', bankConfig.BussId); // AN20: 20位商户号
    header.ele('MerTp', '01'); // 01-普通商户 02-平台商户
    header.ele('Drctn', '12'); // 11-请求 12-应答
    header.ele('EncKey', '');
    header.ele('PubKeyId', ''); // 公钥标识
    header.ele('SysNo', ''); // 前端系统标识

    const body = xml.ele('MsgBody', );
    body.ele('RespCode', '000000');
    body.ele('RespMsg', '交易成功');
    for (var key in msgBody) {
        body.ele(key, msgBody[key]);
    }
    const xmlStr = xml.end();
    return xmlStr + '\r\n' + '{S:' + PKCS7.sign(xmlStr.match(/<root>.*<\/root>/)[0]) + '}';
  }
}
