'use strict'

import http from 'http'
import https from 'https'
import s3 from 's3'
import fs from 'fs'
import path from 'path'
import ProgressBar from 'progress'
import cdnizer from 'cdnizer'

http.globalAgent.maxSockets = https.globalAgent.maxSockets = 50

export default class S3Plugin {
  constructor(options = {s3Options: {}}) {
    var {s3Options, directory, include, exclude, basePath, cdnizerOptions, htmlFiles} = options

    this.requiredS3Opts = ['accessKeyId', 'secretAccessKey', 'Bucket']
    this.isConnected = false
    this.cdnizerOptions = cdnizerOptions
    this.urlMappings = []
    this.uploadTotal = 0
    this.uploadProgress = 0

    this.options = {
      directory, 
      include, 
      exclude, 
      htmlFiles: typeof htmlFiles === 'string' ? [htmlFiles] : htmlFiles
    }

    this.clientConfig = {
      maxAsyncS3: 50,
      s3Options
    }

    if (!this.cdnizerOptions.files)
      this.cdnizerOptions.files = []

    if (!this.cdnizerOptions)
      this.noCdnizer = true
  }

  apply(compiler) {
    var hasRequiredOptions = this.requiredS3Opts
      .every(type => this.clientConfig.s3Options[type])

    // Set directory to output dir or custom
    this.options.directory = this.options.directory || compiler.options.output.path

    compiler.plugin('after-emit', (compilation, cb) => {
      if (!hasRequiredOptions) {
        compilation.errors.push(new Error('S3Plugin: Must provide Bucket, secretAccessKey and accessKeyId'))
        cb()
      }

      fs.readdir(this.options.directory, (error, files) => {
        if (error) {
          compilation.errors.push(new Error('S3Plugin-ReadOutputDir: ' + error))
          cb()
        } else {
          this.uploadFiles(this.filterAllowedFiles(files))
            .then(this.changeHtmlUrls.bind(this))
            .then(() => {
              console.log('Finished Uploading to S3')
              cb()
            })
            .catch(e => {
              //console.log(e)
              compilation.errors.push(new Error('S3Plugin: ' + e))
              cb()
            })
        }
      })
    })
  }

  cdnizeHtml(htmlPath) {
    return new Promise((resolve, reject) => {
      fs.readFile(htmlPath, (err, data) => {
        if (err)
          return reject(err)

        fs.writeFile(htmlPath, this.cdnizer(data.toString()), function(err) {
          if (err)
            return reject(err)

          resolve()
        })
      })
    })
  }

  changeHtmlUrls() {
    if (this.noCdnizer)
      return Promise.resolve()

    var {directory, htmlFiles} = this.options

    var allHtml = htmlFiles || fs.readdirSync(directory)
      .filter(file => /\.html$/.test(file))
      .map(file => path.resolve(directory, file))

    this.cdnizer = cdnizer(this.cdnizerOptions)

    return Promise.all(allHtml.map(file => this.cdnizeHtml(file)))
  }

  filterAllowedFiles(files) {
    return files.reduce((res, file) => {
      if (this.isIncludeOrExclude(file))
        res.push({
          name: file,
          path: path.resolve(this.options.directory, file)
        })

      return res
    }, [])
  }

  isIncludeOrExclude(file) {
    var isExclude,
        isInclude,
        {include, exclude} = this.options

    if (!include)
      isInclude = true
    else 
      isInclude = include.test(file)

    if (!exclude)
      isExclude = false
    else
      isExclude = exclude.test(file)

    return isInclude && !isExclude
  }

  connect() {
    if (this.isConnected)
      return

    this.client = s3.createClient(this.clientConfig)
    this.isConnected = true
  }

  uploadFiles(files = []) {
    return Promise.all(files.map(file => this.uploadFile(file.name, file.path)))
  }

  uploadFile(fileName, file) {
    this.connect()
    var upload = this.client.uploadFile({
      localFile: file,
      s3Params: {
        Key: fileName,
        Bucket: this.clientConfig.s3Options.Bucket
      }
    })

    //var progressBar = new ProgressBar('Uploading [:bar] :percent :etas', {
      //complete: '>',
      //incomplete: '-',
      //total: 100
    //})

    this.cdnizerOptions.files.push(fileName)

    console.log('Uploading ', fileName)
    return new Promise((resolve, reject) => {
      upload.on('error', reject)

      upload.on('progress', function() {
        var progress = (upload.progressAmount / upload.progressTotal).toFixed(2)

        //progressBar.update(progress)
      })

      upload.on('end', () => resolve(file))
    })
  }
}