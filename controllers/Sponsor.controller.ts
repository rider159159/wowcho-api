
import { Request, Response } from 'express'
import { Sponsor } from '../models/Sponsor.model'
// import { PayOrder } from '../models/PayOrder.model'
import { create_mpg_aes_encrypt, create_mpg_sha_encrypt, create_mpg_aes_decrypt } from '../middlewares/Pay.middleware'
import { errorHandler } from '../services/errorHandler'
import { ERROR } from '../const'
import { Plan } from '../models/Plan.model'


export const { MerchantID, Host, ReturnURL, NotifyURL, FrontendHost } = process.env
export const SponsorController = {
  async createEncode(req: Request, res: Response){
    try{
      // TODO: 添加 ownerId (使用者) proposalUrl (專案網址) planId(方案 id)
      const { planId } = req.body
      const plan = await Plan.findById({ _id: planId }).catch(()=>{
        throw { message: '方案 ID 錯誤'}
      })
      if (plan.quantity !== null && plan.quantity <= 0 ){
        throw { message: '此方案數量為 0'}
      }
      // 1. 檢查使用者 body 、 驗證 planId 是否還有數量
      const newSponsor =  new Sponsor(req.body)
      const validateError = newSponsor.validateSync()
      if (validateError) throw validateError
      const sponsorData = newSponsor.toObject() // 或者 newSponsor.toJSON();
      
      // 2. 轉換資料
      const createData = {
        // 會員等其他資料
        // 藍新必要資料
        ...sponsorData,
        MerchantID: MerchantID,
        TimeStamp: Math.round(Date.now()),
        Version: '2.0',
        RespondType: 'JSON',
        CREDIT: 1,
        MerchantOrderNo: sponsorData._id
        // ReturnURL: encodeURIComponent(ReturnURL),
        // NotifyURL: encodeURIComponent(NotifyURL),
      }

      const aesEncrypt = create_mpg_aes_encrypt(createData)
      // 使用 HASH 再次 SHA 加密字串，作為驗證使用
      const shaEncrypt = create_mpg_sha_encrypt(aesEncrypt)
      createData.TradeInfo = aesEncrypt
      createData.TradeSha = shaEncrypt

      // 3. 將資料存 DB
      await Sponsor.create(createData).catch((e) => {
        throw {  message: `新增錯誤:${e}` }
      })

      // 將訂單資訊整理加密後，回傳給前端，前端使用此資料，才能金流認證通過
      res.json({ aesEncrypt, shaEncrypt })

    } catch(e) {
      errorHandler(res, e)
    }
  },
  async mpgReturn(req: Request, res: Response){ //從藍新取得交易結果
    try {
      // 解密交易內容

      if (!Object.prototype.hasOwnProperty.call(req.body, 'TradeInfo')) throw {  message: '付款失敗，請聯絡渦潮客服人員' }
      const request = req.body
      const thisShaEncrypt = await create_mpg_sha_encrypt(request.TradeInfo)
      const data = await create_mpg_aes_decrypt(request.TradeInfo)
      // 解碼後資料不相同、藍新狀態碼錯誤， 回傳錯誤
      if( thisShaEncrypt !== request.TradeSha || !request.Status ){
        throw { message: '付款失敗，請聯絡渦潮客服人員' }
      }
      // 轉址 query 戴上，方案名稱、付款方式、付款實踐
      res.redirect(`${FrontendHost}/#/cart/success?ItemDesc=${data.ItemDesc}&PaymentType=${data.PaymentType}&PayTime=${data.PayTime}`) //轉址前端路由頁面
    } catch(e) {
      errorHandler(res, e)
    }
  },
  async mpgNotify(req: Request, res: Response){ //從藍新幕後取得交易結果並存資料庫
    try{
      const request = req.body
      if (!Object.prototype.hasOwnProperty.call(req.body, 'TradeInfo')) throw {  message: '付款失敗，請聯絡渦潮客服人員' }
      const thisShaEncrypt = await create_mpg_sha_encrypt(request.TradeInfo)
      // 1.檢查回傳資料
      // 使用 HASH 再次 SHA 加密字串，確保比對一致、藍新狀態碼錯誤， 回傳錯誤
      if (thisShaEncrypt !== request.TradeSha || !request.Status ) {
        throw {  message: '付款失敗，請聯絡渦潮客服人員' }
      }

      // 解密交易內容
      const data = await create_mpg_aes_decrypt(request.TradeInfo)
      const result = data.Result
      // 2. 透過回傳資料 MerchantOrderNo，查詢資料庫 (id)
      const findSponsor = await (await Sponsor.findOne({ _id: result.MerchantOrderNo })).toObject()
      // 3. 調整資料庫資料
      findSponsor.payStatus = true
      let newSponsor = null
      newSponsor = {
        // 原本有的資料 
        ...findSponsor,
        // 添加藍新回傳後資料
        IP: result.IP,
        TradeNo: result.TradeNo,
        EscrowBank: result.EscrowBank,
        PaymentType: result.PaymentType,
        RespondCode: result.RespondCode,
        // 信用卡
        Auth: result.Auth ? result.Auth : '',
        Card6No: result.Card6No ? result.Card6No : '',
        Card4No: result.Card4No ? result.Card4No : '',
        AuthBank: result.AuthBank ? result.AuthBank : '',
        PayTime: result.PayTime ?  result.PayTime : '',
        PaymentMethod: result.PaymentMethod ? result.PaymentMethod : '',
        // 取貨付款
        StoreCode: result.StoreCode ? result.StoreCode : '',
        StoreType: result.StoreType ? result.StoreType : '',
        StoreName: result.StoreName ? result.StoreName : '',
        TradeType: result.TradeType ? result.TradeType : '',
        StoreAddr: result.StoreAddr ? result.StoreAddr : '',
        CVSCOMName: result.CVSCOMName ? result.CVSCOMName : '',
        CVSCOMPhone: result.CVSCOMPhone ? result.CVSCOMPhone : '',
        LgsType: result.LgsType ? result.LgsType : '',
        LgsNo: result.LgsNo ? result.LgsNo : '',
      }
      // 4.將修改後資料存至資料庫、同時減少 plan 數量資料

      const sponsor = await Sponsor.findByIdAndUpdate(findSponsor._id, newSponsor,{
        new: true, // 返回更新後的文檔
        upsert: false, // 如果沒找到匹配的文檔，不要創建新文檔
        runValidators: true, // 觸發 Schema 驗證
      }).catch((e) => {
        throw {  message: `更新錯誤:${e}` }
      })
      console.log('sponsor',sponsor)
      //  plan
      const plan = await Plan.findById({ _id: sponsor.planId })
      console.log('plan', plan)
      await plan.addNowBuyers()

      return res.end()
    }catch(e){
      errorHandler(res, e)
    }
  },
}

